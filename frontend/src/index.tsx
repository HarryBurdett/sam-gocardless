/**
 * GoCardless plugin — UMD bundle entry.
 *
 * Registers the GoCardless component on `window.__SAM_APPS__` so SAM's
 * AppLoader can mount it. The id MUST match
 * `apps-sam/gocardless/manifest.json: "id"` ("gocardless") and the
 * exported component name MUST match
 * `manifest.frontend.entryComponent` ("GoCardless").
 */
import './index.css';
import GoCardless from './GoCardless';

if (typeof window !== 'undefined') {
  window.__SAM_APPS__ = window.__SAM_APPS__ ?? {};
  window.__SAM_APPS__['gocardless'] = {
    id: 'gocardless',
    component: GoCardless as unknown as (props: {
      context: import('./sam').SamPluginContext;
    }) => unknown,
  };
}

export default GoCardless;
