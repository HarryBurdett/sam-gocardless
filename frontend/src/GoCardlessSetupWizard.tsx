import { useState, useEffect } from 'react';
import { CreditCard, ArrowRight, CheckCircle, Loader2, ExternalLink, Settings } from 'lucide-react';
import { authFetch } from './api-shim';

// SAM port — react-router-dom isn't loaded in SAM plugins. The wizard
// uses navigate() to redirect on completion; in SAM the host owns
// routing, so this stub fires a custom event the host can listen on.
function useNavigate() {
  return (path: string) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('sam:navigate', { detail: { path } }),
      );
    }
  };
}

export function GoCardlessSetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'welcome' | 'details' | 'waiting' | 'complete'>('welcome');
  const [companyName, setCompanyName] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorisationUrl, setAuthorisationUrl] = useState<string | null>(null);
  const [partnerConfigured, setPartnerConfigured] = useState(false);

  // Check if partner credentials are configured
  useEffect(() => {
    authFetch('/api/gocardless/partner/config')
      .then(res => res.json())
      .then(data => {
        if (data.success) setPartnerConfigured(data.partner_configured);
      })
      .catch(() => {});
  }, []);

  // Poll for completion when waiting
  useEffect(() => {
    if (step !== 'waiting') return;

    const interval = setInterval(async () => {
      try {
        const res = await authFetch('/api/gocardless/partner/signup-status');
        const data = await res.json();
        if (data.success && data.signup?.status === 'completed') {
          setStep('complete');
        }
      } catch { /* continue polling */ }
    }, 5000);

    return () => clearInterval(interval);
  }, [step]);

  const handleInitiateSignup = async () => {
    if (!companyEmail) {
      setError('Please enter your company email');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await authFetch('/api/gocardless/partner/initiate-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: companyName, company_email: companyEmail }),
      });
      const data = await res.json();

      if (data.success) {
        if (data.authorisation_url) {
          // Partner OAuth flow — open GoCardless in new tab
          setAuthorisationUrl(data.authorisation_url);
          window.open(data.authorisation_url, '_blank', 'noopener,noreferrer');
        }
        setStep('waiting');
      } else {
        setError(data.error || 'Failed to initiate signup');
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto py-12">
      <div className="text-center mb-8">
        <div className="inline-flex p-4 rounded-2xl bg-emerald-50 mb-4">
          <CreditCard className="h-10 w-10 text-emerald-500" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Crakd.ai DD</h1>
        <p className="text-sm text-gray-500 mt-1">Direct Debit Management powered by GoCardless</p>
      </div>

      {step === 'welcome' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-800">Get Started with GoCardless</h2>
          <p className="text-sm text-gray-600">
            GoCardless lets you collect Direct Debit payments from your customers automatically.
            Payments are matched to your Opera invoices and posted as Sales Receipts — fully automated.
          </p>

          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-600">Automatic customer matching and invoice allocation</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-600">Fees tracking with VAT for your VAT return</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-600">Payment requests against specific invoices</span>
            </div>
            <div className="flex items-start gap-2">
              <CheckCircle className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-600">Complete audit trail in Opera</span>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setStep('details')}
              className="btn btn-primary flex items-center gap-2"
            >
              Sign Up for GoCardless
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => navigate('/cashbook/gocardless-settings')}
              className="btn btn-secondary flex items-center gap-2"
            >
              <Settings className="h-4 w-4" />
              I already have an API key
            </button>
          </div>
        </div>
      )}

      {step === 'details' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-800">Company Details</h2>
          <p className="text-sm text-gray-500">
            {partnerConfigured
              ? "Enter your details below. You'll be redirected to GoCardless to complete registration."
              : "Enter your details below. You'll need to register at GoCardless and enter your API key in Settings."
            }
          </p>

          <div>
            <label className="label">Company Name</label>
            <input
              type="text"
              className="input"
              placeholder="Your company name"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </div>

          <div>
            <label className="label">Company Email</label>
            <input
              type="email"
              className="input"
              placeholder="accounts@yourcompany.com"
              value={companyEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleInitiateSignup}
              disabled={loading}
              className="btn btn-primary flex items-center gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {loading ? 'Setting up...' : partnerConfigured ? 'Continue to GoCardless' : 'Register'}
            </button>
            <button onClick={() => setStep('welcome')} className="btn btn-secondary">
              Back
            </button>
          </div>
        </div>
      )}

      {step === 'waiting' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center space-y-4">
          <Loader2 className="h-8 w-8 text-blue-500 animate-spin mx-auto" />
          <h2 className="text-lg font-semibold text-gray-800">Complete Your GoCardless Setup</h2>

          {authorisationUrl ? (
            <>
              <p className="text-sm text-gray-500">
                A GoCardless registration page has opened in a new tab.
                Complete the signup process there, then return here.
              </p>
              <div className="pt-2">
                <a
                  href={authorisationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary inline-flex items-center gap-2"
                >
                  <ExternalLink className="h-4 w-4" />
                  Reopen GoCardless Registration
                </a>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-500">
                Visit <a href="https://manage.gocardless.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">GoCardless Dashboard <ExternalLink className="h-3 w-3" /></a> to create your account, then add your API key in Settings.
              </p>
              <div className="pt-2">
                <button
                  onClick={() => navigate('/cashbook/gocardless-settings')}
                  className="btn btn-primary flex items-center gap-2 mx-auto"
                >
                  <Settings className="h-4 w-4" />
                  Go to Settings to enter API key
                </button>
              </div>
            </>
          )}

          <p className="text-xs text-gray-400">
            This page checks automatically every 5 seconds. It will update when setup is complete.
          </p>
        </div>
      )}

      {step === 'complete' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center space-y-4">
          <CheckCircle className="h-12 w-12 text-emerald-500 mx-auto" />
          <h2 className="text-lg font-semibold text-gray-800">GoCardless is Ready</h2>
          <p className="text-sm text-gray-500">
            Your GoCardless account is connected. You can now import Direct Debit payments.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-primary mx-auto"
          >
            Start Using GoCardless Import
          </button>
        </div>
      )}
    </div>
  );
}
