# Putting LocalLens online (Render + MongoDB Atlas, free)

What runs where:
- **Render:** the app (one Docker image with the API and the website), plus a small free Redis for rate limits. Set up from `render.yaml`.
- **MongoDB Atlas:** the database (free M0, 512 MB).
- **Ask AI:** off online. No AI service is configured, so the app hides the button. To turn it on later, set `AI_SERVICE_URL` and `AI_SERVICE_TOKEN`.
- **Photos:** stored in the database. Add `CLOUDINARY_URL` later only if space runs low.

Free-plan limits:
- The Render app sleeps after 15 minutes without visitors, so the next visit takes about 50 seconds to wake it.
- News imports run only while it is awake.
- Render's Starter plan ($7/month) keeps it always on.

## 1. Code on GitHub
Create an **empty private** repository on github.com (no README). Then push the code:
```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 2. Database: MongoDB Atlas
1. Sign up at https://www.mongodb.com/cloud/atlas/register and create a **free M0** cluster. A region near India works best, e.g. AWS Mumbai.
2. **Database Access:** add a database user with a long random password.
3. **Network Access:** add `0.0.0.0/0`. Render's free plan has no fixed IP, and the user's password still protects the database.
4. **Connect → Drivers:** copy the connection string and put `/locallens` before the `?`, e.g.
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/locallens?retryWrites=true&w=majority`
5. Keep the string private. Do not paste it in chats.

## 3. App: Render
1. Sign up at https://render.com with your GitHub account.
2. **New → Blueprint**, choose the repository, and Render reads `render.yaml`.
3. When it asks for `MONGODB_URI`, paste the Atlas connection string. Everything else is filled in automatically, including the https address and a random encryption key.
4. **Apply.** The first build takes about 5–10 minutes.
5. Open `https://<name>.onrender.com/healthz`. It should show `{"status":"ok"}`.

If the deploy fails, open the service's **Logs**. A line starting `Invalid environment configuration` names the setting to fix.

## 4. Places and the first admin (from this PC)
Put the Atlas connection string in a file named `.env.atlas` in the project folder. Files named `.env.*` are never committed. It holds one line:
```
MONGODB_URI=mongodb+srv://...
```
Then load the villages:
```bash
npx tsx --env-file=.env.atlas apps/api/src/scripts/import-osm.ts --state "Andhra Pradesh" --te "ఆంధ్రప్రదేశ్" --districts "Tirupati,Chittoor"
```
This uses the files already saved in `data/osm/`, so it takes seconds.

Next, create your admin account:
1. Sign up on the live site with the email address you want as admin.
2. Make that account an admin:
   ```bash
   npx tsx --env-file=.env.atlas apps/api/src/scripts/promote-admin.ts you@example.com
   ```

Staff accounts online must use **two-step sign-in**. After the first admin sign-in, the app asks you to scan a QR code with an authenticator app (Google Authenticator, Microsoft Authenticator…). Keep the recovery codes it shows.

## 5. Check
- Open the site on a phone: news cards, open a story, Share.
- Sign up as a reporter and post with a photo; check the place suggestions (e.g. "Kuppam").
- Chrome on Android: **Install the app**.

## Updating later
Push to `main` and Render rebuilds and redeploys automatically.
