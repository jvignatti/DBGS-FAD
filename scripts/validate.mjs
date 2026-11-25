// Page-level validation gate. Returns a list of errors; empty list = valid.
// Catches the failure seen in discovery: CloudFront serving an
// "ERROR: The request could not be satisfied" page that prints like a real page.

export const SOURCE_URL = 'https://bgs.vermont.gov/purchasing-contracting/debarment';
export const USER_AGENT = 'Mozilla/5.0 (compatible; DBGS-FAD/0.1; +https://github.com/jvignatti/DBGS-FAD)';

export function validatePage({ status, finalUrl, title, h1 }) {
  const errors = [];
  if (status !== 200) errors.push(`HTTP status ${status}, expected 200.`);
  if (finalUrl !== SOURCE_URL) errors.push(`Final URL ${finalUrl} differs from the official source URL (redirect or wrong page).`);
  if (!/Debarment List/.test(title || '')) errors.push(`Page title "${title}" does not contain "Debarment List".`);
  if (/ERROR|request could not be satisfied/i.test(title || '')) errors.push(`Page title "${title}" looks like an error page.`);
  if (!/Debarment List/.test(h1 || '')) errors.push(`Main heading "${h1}" does not contain "Debarment List".`);
  return errors;
}
