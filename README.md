# Property Scorecard

Property inspection scorecard for Melbourne outer-suburb investment analysis.

## Local Development

1. Install dependencies:
   ```
   npm install
   ```
2. Start the app:
   ```
   npm run dev
   ```
3. Open [http://localhost:3000](http://localhost:3000)

## Cloud Sync (cross-device persistence)

The app now supports cloud sync through Upstash Redis (via Vercel integration), so your data can be shared between phone and desktop.

### 1) Set server environment variables

In Vercel project settings, add:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

You can get these automatically by installing a Redis integration from the Vercel marketplace.

### 2) Deploy

Redeploy after adding environment variables.

### 3) Connect devices

In the app, open `☁ Sync` and:

1. Enter a private sync key.
2. Press `Connect`.
3. Use the exact same key on your other device(s).

`Pull latest` fetches cloud data; `Push now` forces upload; `Auto-sync` keeps cloud updated after edits.

## Project Structure

- Main app: `src/app/page.tsx`
- Sync API route: `src/app/api/sync/route.ts`
- Root layout: `src/app/layout.tsx`

## License

Released under the MIT License. See `LICENSE`..
