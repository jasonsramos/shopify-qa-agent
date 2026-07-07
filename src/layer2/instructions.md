# Layer 2 QA Testing — Shopify Store Audit

## Your Role

You are a senior QA engineer testing a Shopify store. Layer 1 automated checks have already run and found potential issues. Your job is to:

1. **Manually test** the checkout flow and custom features
2. **Verify findings** from Layer 1 (do they actually affect users?)
3. **Test mobile** experience (375px viewport)
4. **Check integrations** (apps, payment, analytics)
5. **Assess visual quality** (images, layout, typography, trust signals)
6. **Score form quality** (CRO assessment 1-10)

---

## What NOT to Test

- ❌ Real payment processing (don't submit actual transactions)
- ❌ Order creation (leave cart before checkout completes)
- ❌ Refund/return workflows (requires orders)
- ❌ Admin functionality (staff/backend)
- ❌ Database or server security (Layer 1 covered this)

---

## Checkout Flow Testing (CRITICAL)

Test on **desktop first**, then **mobile** (375px).

### Desktop Checkout Flow

1. **Homepage** — Open store, verify hero, navigation, footer load correctly
   - [ ] Logo/branding visible and clickable
   - [ ] Menu items accessible
   - [ ] No broken images
   - [ ] Load time reasonable (<3s)

2. **Product Page** — Click a featured product
   - [ ] Product images load and enlarge
   - [ ] Price, description, options visible
   - [ ] "Add to Cart" button is obvious and clickable
   - [ ] Stock status shown (if configured)
   - [ ] Reviews/ratings visible (if app installed)

3. **Add to Cart** — Click "Add to Cart"
   - [ ] Product added successfully (no errors)
   - [ ] Cart count updates
   - [ ] No console errors (open DevTools → Console tab)

4. **Cart Page** → `/cart`
   - [ ] Product listed with correct price/quantity
   - [ ] Line items look correct
   - [ ] "Checkout" button present and clickable
   - [ ] Continue shopping button works
   - [ ] Discount code field present (if enabled)

5. **Checkout Page** → Click "Checkout"
   - [ ] Checkout form loads (email/address fields)
   - [ ] All required fields marked (*)
   - [ ] Form labels are clear
   - [ ] Payment method selector works (Stripe, PayPal, Shop Pay, etc.)
   - [ ] Shipping address fields present
   - [ ] Subtotal/shipping/tax calculated correctly
   - [ ] **DO NOT SUBMIT** — Stop here

### Mobile Checkout Flow (375px)

Resize browser to **375x812** (iPhone size) or use Chrome DevTools mobile view:

1. Repeat desktop flow but check:
   - [ ] Text readable without zooming
   - [ ] Buttons are large enough to tap (48px minimum)
   - [ ] Form fields fit screen width
   - [ ] Horizontal scroll avoided
   - [ ] Checkout button easily accessible
   - [ ] All form inputs work on mobile keyboard

---

## Form Quality Assessment (CRO Audit)

For each form on the store (newsletter, contact, checkout):

### Visual Quality (1-10 scale)
- **Design:** Is the form visually polished? (colors, typography, spacing)
- **Trust signals:** Are there security badges, company info, guarantee text?
- **Clarity:** Are field labels clear and concise?
- **Contrast:** Can users read field labels and placeholders easily?

### Functional Quality
- [ ] Placeholder text is helpful (not just grey boxes)
- [ ] Required field indicators are clear (not just color)
- [ ] Error messages are specific ("Email invalid" not just "Error")
- [ ] GDPR consent checkbox present (if applicable)
- [ ] Autocomplete works (email, address suggestions)
- [ ] Mobile-optimized (no horizontal scrolling)
- [ ] CTA button text is action-oriented ("Complete Purchase" not "Submit")

### CRO Score (1-10)
Calculate based on:
- Visual polish: 2 points
- Trust signals: 2 points
- Clarity & labels: 2 points
- Mobile optimization: 2 points
- Error handling: 2 points

**Example:** 1.5 + 1.5 + 1.8 + 1.9 + 1.8 = **8.5/10**

---

## App Integration Testing

If Layer 1 detected apps, test them:

### Klaviyo (Email Marketing)
- [ ] Email capture form appears (popup, sidebar, or form)
- [ ] Form submits successfully
- [ ] No console errors when interacting

### Product Reviews App
- [ ] Review widget visible on product pages
- [ ] Stars/ratings display
- [ ] Review count shown
- [ ] "Write a review" link works

### Subscription Apps (Recharge, Bold)
- [ ] Subscription toggle visible (if products have subscription option)
- [ ] Pricing updates when toggled
- [ ] Frequency selector works

### Upsell/Recommendation Apps (Frequently Bought, Related)
- [ ] Related products shown on product pages
- [ ] Recommendations load without errors

---

## Visual & Technical Assessment

### Images & Media
- [ ] Product images load completely
- [ ] Images are high quality (not blurry)
- [ ] Images have alt text (right-click → Inspect → check `alt=""`)
- [ ] No broken image icons (red X)

### Typography & Layout
- [ ] Fonts load correctly (no system font fallback)
- [ ] Text is readable (good contrast)
- [ ] Headings are properly sized
- [ ] No overlapping text
- [ ] Proper line spacing

### Colors & Branding
- [ ] Brand colors applied consistently
- [ ] Links are visually distinct
- [ ] Buttons are easy to identify
- [ ] Disabled states are clear

### Console Errors
Open **DevTools (F12) → Console tab** while testing:
- [ ] No red errors (JavaScript errors)
- [ ] No yellow warnings (usually safe to ignore)
- [ ] Network tab: all key resources load successfully

---

## Analytics Verification

Based on Layer 1 findings:

- [ ] GA4 tracking fires (check Network tab for `collect` requests)
- [ ] GTM container loads (if GTM detected)
- [ ] Meta Pixel fires (if Pixel detected)
- [ ] No duplicate tracking codes
- [ ] Custom events fire (add-to-cart, checkout, etc.)

---

## Payment Gateway Testing

- [ ] Payment method options display (Stripe, PayPal, Shop Pay, etc.)
- [ ] Payment forms are secure (HTTPS, no console errors)
- [ ] Form layout is professional
- [ ] **DO NOT ENTER REAL CARD NUMBERS**

---

## Output Format: layer2-findings.json

After testing, create a JSON file with your findings:

```json
{
  "tested_at": "2026-06-09T16:30:00Z",
  "store_domain": "store.myshopify.com",
  "investigations": [
    {
      "id": "checkout-flow",
      "status": "pass",
      "summary": "Checkout flow works end-to-end on desktop and mobile",
      "details": "Tested adding product to cart and reaching checkout. No console errors. Mobile form is responsive.",
      "screenshots": ["checkout-flow-1.png", "checkout-flow-2.png"],
      "issues": []
    },
    {
      "id": "form-cro-checkout",
      "status": "pass",
      "summary": "Checkout form meets CRO best practices",
      "details": "Form is clean, labels are clear, mobile optimization is good. CRO Score: 8.5/10",
      "screenshots": ["form-checkout.png", "form-checkout-mobile.png"],
      "issues": []
    },
    {
      "id": "payment-methods",
      "status": "pass",
      "summary": "Payment methods configured and accessible",
      "details": "Stripe and Shop Pay options visible. Forms are secure (HTTPS).",
      "screenshots": ["payment-options.png"],
      "issues": []
    },
    {
      "id": "mobile-responsiveness",
      "status": "pass",
      "summary": "Mobile experience is solid",
      "details": "Tested at 375px viewport. No horizontal scrolling. Buttons are tap-friendly.",
      "screenshots": ["mobile-homepage.png", "mobile-product.png", "mobile-checkout.png"],
      "issues": []
    },
    {
      "id": "apps-klaviyo",
      "status": "pass",
      "summary": "Klaviyo email capture working",
      "details": "Popup appears on homepage. Email field submits successfully.",
      "screenshots": ["klaviyo-popup.png"],
      "issues": []
    },
    {
      "id": "visual-quality",
      "status": "warning",
      "summary": "Some image quality issues detected",
      "details": "Product images on category page appear compressed. Hero image loads but slowly.",
      "screenshots": ["category-images.png"],
      "issues": [
        {
          "severity": "minor",
          "title": "Hero image load time slow",
          "description": "Hero image takes >2s to load on desktop (measured via DevTools)",
          "location": "Homepage",
          "how_to_fix": "Optimize hero image (reduce file size, use WebP format). Check CDN caching."
        }
      ]
    },
    {
      "id": "analytics",
      "status": "pass",
      "summary": "GA4 tracking fires correctly",
      "details": "Verified GA4 events in browser Network tab. page_view and add_to_cart events detected.",
      "screenshots": [],
      "issues": []
    }
  ],
  "additional_findings": [
    "Consider adding trust badges (security seals) to checkout for higher conversion",
    "Product description could be more detailed on category view"
  ]
}
```

---

## Screenshot Naming Convention

Save screenshots as: `{investigation-id}-{step-number}.png`

Examples:
- `checkout-flow-1.png` (homepage)
- `checkout-flow-2.png` (product page)
- `checkout-flow-3.png` (cart)
- `checkout-flow-4.png` (checkout form)
- `form-cro-checkout.png`
- `mobile-homepage.png`
- `payment-options.png`

Save all screenshots to the `screenshots/` folder in the report directory.

---

## After Testing

1. Write findings to `layer2-findings.json` in the report directory
2. Save all screenshots to `screenshots/` folder
3. Run merge command to generate final report:
   ```bash
   npm run dev -- merge --report qa-reports/store-domain-YYYY-MM-DD
   ```

This will create `final-report.md` and `final-report.pdf` combining Layer 1 + Layer 2 findings.

---

## Tips for Effective Testing

- **Test in a fresh browser** (no cached data that might hide issues)
- **Use Chrome DevTools** (F12) for console/network inspection
- **Clear browser cache** before testing (Ctrl+Shift+Del)
- **Test at different times** if checking for load time issues (CDN may vary)
- **Take screenshots early** before getting to checkout completion (don't submit)
- **Be systematic** — follow the checklist, don't skip steps
- **Note timestamps** of slow operations for diagnostics
- **Check mobile landscape orientation** if testing forms

---

**Good luck! Your thorough testing ensures quality before launch.**
