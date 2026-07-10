# examples

Demo fixtures for `statelinter --ui`. `react-app/` triggers `server-state-in-client-state`
(useState+useEffect fetch); `vue-app/` uses a Pinia store (`stores/cart.ts`) consumed by
`Cart.vue`. Not part of the build or test suite — scan-only targets.

```
npx tsx src/cli.ts --ui --port 4479 examples/react-app
npx tsx src/cli.ts --ui --port 4478 examples/vue-app
```
