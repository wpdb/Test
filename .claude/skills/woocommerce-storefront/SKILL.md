---
name: woocommerce-storefront
description: Use when editing WooCommerce storefront products, cart, checkout, orders, customer accounts, payments, taxes, shipping, currency, or PhantomWP Connect Woo bridge code.
---

# WooCommerce Storefront

Use PhantomWP Connect as the transactional source of truth. Public product browsing can use WooCommerce Store API, but checkout, orders, customer data, VAT/tax, shipping rates, countries, and payment gateway config must come from the PhantomWP Connect Woo bridge.

## Rules

- Do not add new generated storefront flows that require Woo consumer key/secret in the browser or user-facing setup.
- Do not hand-calculate VAT, shipping zones, coupons, or order totals in Astro when WooCommerce can calculate them.
- Use Woo ISO country codes from store config; never accept free-text countries for checkout/account addresses.
- Treat order detail as sensitive: guest views require `order_id + order_key`; customer views require a valid PhantomWP JWT and ownership check.
- Use Woo currency config for all prices. Avoid hardcoded `USD` or `$` fallbacks.
- Paddle gateway data may be detected/imported, but do not promise Paddle checkout unless a concrete supported implementation exists.

## Files To Check

- `src/pages/api/checkout/config.ts`, `src/pages/api/orders/create.ts`, and customer/order API routes
- `src/pages/checkout.astro`, `src/pages/order-complete.astro`, and account pages
- `src/lib/woocommerce.ts`, `src/lib/cart.ts`, and `src/lib/payments.ts`
