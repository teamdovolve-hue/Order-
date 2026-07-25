---
name: Live deployment split
description: The relationship between the Replit workspace, the live QR ordering hostname, and the separate root website.
---

The customer QR ordering app is served from Netlify at `ordernow.newpizzahutnlivecake.in`; the Replit workflow is only the development preview. The root `newpizzahutnlivecake.in` redirects to a separate Vercel website.

**Why:** A Firebase error-message change in Replit was not visible on the live ordering site because Netlify had not been redeployed.

**How to apply:** Treat Netlify as the release path for this app. After changing the Firebase/auth code, rebuild or redeploy the Netlify site and verify the exact `ordernow` hostname, Firebase project, and deployed asset contents.