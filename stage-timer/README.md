# Stage Timer

Countdown timer, programme schedule and HDMI / browser-source output for stage production. Runs fully offline.

## 1. One-time setup (ADMIN)
```
npm install
npm run keygen:init          # creates keys/private.pem (keep secret, back up!) and src/public.pem
```
- Put your licensed copy of **Varien Bold** at `assets/fonts/Varien-Bold.ttf` (check its licence allows distribution). Without it the stage display falls back to Poppins ExtraBold.
- Optional: put your hosted Visa/MoMo checkout link (Paystack, Hubtel, Flutterwave…) in `src/config.json` → `paymentUrl`.

## 2. Run / build
```
npm start                    # run in development
npm run dist:win             # Windows installer  -> dist/Stage Timer Setup 1.0.0.exe   (run on Windows)
npm run dist:mac             # macOS .dmg (Intel + Apple Silicon)                         (run on a Mac)
```
No Mac or PC handy? Push this folder to GitHub and run **Actions → Build installers**; it builds both and attaches them as downloads.

## 3. Selling licenses
After a customer pays (MoMo 0552231869 or card):
```
npm run keygen:issue -- "Customer Name" customer@email.com        # lifetime
npm run keygen:issue -- "Customer Name" customer@email.com 365    # 1 year
```
Send them the printed key; they paste it in **Upgrade & support → License**. Keys are verified offline with your public key.

## Output
- **HDMI**: Timer tab → pick the display → *Open output*.
- **NDI / OBS / vMix**: add a Browser Source → `http://127.0.0.1:4777/output.html`, then send it out with the OBS NDI plugin (DistroAV) or NDI Screen Capture.
- Space bar starts/pauses the timer.
