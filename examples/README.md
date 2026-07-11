# examples

Demo fixtures for `statelinter --ui`. `react-app/` triggers `server-state-in-client-state`
(useState+useEffect fetch); `vue-app/` uses a Pinia store (`stores/cart.ts`) consumed by
`Cart.vue`. Not part of the build or test suite — scan-only targets.

`mixed-app/` is the exception: it's the app drawn in the landing page's graph
(site/index.html, "The model" section) — five React+Vue components, six state
sources, and exactly one finding: `multiple-sources-of-truth` on the cart
entity (`pinia:cart` vs the localStorage `"cart"` key).
`src/graph/site-graph.test.ts` pins the scan to the drawing, so this fixture
IS part of the test suite — change it and the test tells you to redraw.

```
npx tsx src/cli.ts --ui --port 4479 examples/react-app
npx tsx src/cli.ts --ui --port 4478 examples/vue-app
npx tsx src/cli.ts --ui --port 4477 examples/mixed-app
```
