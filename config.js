// =============================================================================
// Justlife Teleconsultation — website configuration
// This file is public (anyone can read it in the browser): never put passwords
// or secrets here. Business settings live in the "Settings" tab of the sheet.
// =============================================================================
const CONFIG = {
  // 1) Your Apps Script web app URL — the bridge between this website and the
  //    Google Sheet. In the sheet: Extensions → Apps Script → Deploy →
  //    New deployment → Web app (Execute as: Me · Who has access: Anyone) →
  //    copy the URL that ends in /exec.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID/exec',

  // 2) Your Google OAuth "Web application" client ID (…apps.googleusercontent.com).
  //    Must be identical to GOOGLE_CLIENT_ID in the Settings tab of the spreadsheet.
  //    Not needed while Settings ▸ AUTH_MODE = test.
  GOOGLE_CLIENT_ID: '676386166698-m6lkakhva28q1f5h4nqdqrad0cg75cmj.apps.googleusercontent.com',

  // 3) Your Google Sheet link (the database). Used for the "Open Google Sheet"
  //    button in the staff portal. The data itself is reached through the
  //    Apps Script above, which lives inside this sheet.
  GOOGLE_SHEET_URL: 'https://docs.google.com/spreadsheets/d/PASTE_YOUR_SHEET_ID/edit',

  // 4) Only Google accounts on this domain can sign in to the staff portal
  //    (checked again on the server — Settings ▸ ALLOWED_DOMAIN).
  ALLOWED_DOMAIN: 'justlife.com',

  BRAND_NAME: 'Justlife Healthcare',
  LOGO: 'logo.png',
};
