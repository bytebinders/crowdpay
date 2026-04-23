const CREATOR_KEY = 'cp_onboarding_creator_dismissed';
const CONTRIBUTOR_KEY = 'cp_onboarding_contributor_dismissed';

export function isCreatorOnboardingVisible() {
  return localStorage.getItem(CREATOR_KEY) !== '1';
}

export function dismissCreatorOnboarding() {
  localStorage.setItem(CREATOR_KEY, '1');
}

export function isContributorOnboardingVisible() {
  return localStorage.getItem(CONTRIBUTOR_KEY) !== '1';
}

export function dismissContributorOnboarding() {
  localStorage.setItem(CONTRIBUTOR_KEY, '1');
}

export function markJustRegistered() {
  sessionStorage.setItem('cp_just_registered', '1');
}

export function consumeJustRegistered() {
  if (sessionStorage.getItem('cp_just_registered') !== '1') return false;
  sessionStorage.removeItem('cp_just_registered');
  return true;
}
