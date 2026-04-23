import React from 'react';

export default function OnboardingCallout({ title, children, onDismiss, className = '' }) {
  return (
    <aside className={`onboarding-callout ${className}`.trim()} role="note">
      <div className="onboarding-callout__inner">
        <div className="onboarding-callout__content">
          {title && <h2 className="onboarding-callout__title">{title}</h2>}
          <div className="onboarding-callout__body">{children}</div>
        </div>
        {onDismiss && (
          <button type="button" className="onboarding-callout__dismiss" onClick={onDismiss}>
            Got it
          </button>
        )}
      </div>
    </aside>
  );
}
