# Zoros work notes (October 7, 2026)

This branch (`saved/design-mockups`) is a saved copy of work in progress. It is **not live**. The site only deploys from `main`.

## Now live on `main`

| PR | What |
|----|------|
| #1 | Single-song price is set on the server (patrons can no longer edit the request to pay less) |
| #3 | First-visit welcome card on the patron page ("Search for any song / Pay in a few taps / Hear your song play in the bar", plus a note that unused bundle songs are saved), in EN/ES/NL/FR |
| #4 | New ZOROS lettering image in the patron page header (`public/wordmark.png`) |

## Saved on this branch, not live

These are patron page design changes that were approved as mockups but not shipped:

1. **Credits badge moved.** It sits below the header line, directly under the language button and right-aligned with it. It is 20px below the line, matching the language button's 20px gap above it.
2. **Heading alignment.** The top of the "YOUR NIGHT." letters lines up with the top of the credits badge, which moves the heading up about 9px.
3. **Tagline in capitals.** "SEARCH ANY SONG · PAY · HEAR IT IN THE BAR" is set at 11.5px. French still wraps to two lines on small phones.
4. **New lettering on the language screen** and the "Zoros is turned off" screen.

Note: this branch was started before PR #4, so it also changes the header lettering in a slightly different way. If you use it, bring `main` into this branch first and keep `main`'s header version.

## Other ideas, closed without merging (PR #2, branch `claude/happy-bohr-mqo72p`)

- Instagram button (@zoros.music) in the header
- Vinyl logo on the bar dashboard, team dashboard, login and setup pages
- "Patron accounts" list on the team dashboard with CSV download (records which bar each patron signed up at)
- Fix for an orange bar showing over the last song in the results on some phones

## Open decisions and to-dos

- **Orange.** The site uses `#FF5500`. The new lettering is `#FD6708`, which is slightly yellower. Pick one. If the lettering's orange is the official brand color, change the site to match; otherwise recolor the lettering.
- **Stripe.** Swap `STRIPE_SECRET_KEY` on Railway to the new account's key, ideally a restricted key with these permissions:
  - Checkout Sessions: write
  - PaymentIntents, Charges, Balance transactions: read

  Do the swap when no bars are open, because checkouts that are in progress at the moment of the swap will fail. Then make one real €0.99 test purchase and refund it.
- **Javier's bar.** He is a bar owner. Create his venue with `POST /api/admin/create-venue`. There is no form for this yet; building one into the team dashboard was suggested. Also create a separate test bar for internal testing.
- **French price boxes.** "1 MORCEAU" and "Économise 0,47 €" wrap awkwardly. This is on the live site already.
- **`/api/debug`.** It has no login and shows config flags and which bars are connected. Lock it down at some point.
- **GDPR.** Patron emails can't be used for marketing without an opt-in checkbox at signup.
