import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle, AlertTriangle, Info, X } from 'lucide-react';

type AlertVariant = 'error' | 'warning' | 'info' | 'success';

const config: Record<AlertVariant, { bg: string; border: string; icon: string; title: string; body: string; iconComponent: React.ComponentType<{ className?: string }> }> = {
  error: { bg: 'bg-red-50', border: 'border-red-200', icon: 'text-red-500', title: 'text-red-800', body: 'text-red-700', iconComponent: AlertCircle },
  warning: { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500', title: 'text-amber-800', body: 'text-amber-700', iconComponent: AlertTriangle },
  info: { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-500', title: 'text-blue-800', body: 'text-blue-700', iconComponent: Info },
  success: { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-500', title: 'text-emerald-800', body: 'text-emerald-700', iconComponent: CheckCircle },
};

interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function Alert({ variant = 'info', title, children, onDismiss, className = '' }: AlertProps) {
  const c = config[variant];
  const Icon = c.iconComponent;

  return (
    <div className={`${c.bg} border ${c.border} rounded-xl p-4 flex items-start gap-3 ${className}`}>
      <Icon className={`w-5 h-5 ${c.icon} flex-shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        {title && <p className={`text-sm font-semibold ${c.title}`}>{title}</p>}
        {children && <div className={`text-sm ${c.body} ${title ? 'mt-0.5' : ''}`}>{children}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className={`${c.icon} hover:opacity-70 flex-shrink-0`}>
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
