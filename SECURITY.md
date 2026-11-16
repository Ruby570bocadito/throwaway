# Security policy

Throwaway is a privacy tool: a security problem here can hurt someone who is trying to stay anonymous. Thank you for reporting it privately.

## How to report

- Use GitHub's private reporting: **Security → Report a vulnerability** on this repository.
- If that button is not there, open an issue titled "Security contact" **with no details**, and you will get a private channel.

Please keep the details private until a fix is deployed.

## In scope

- The web app at https://throwaway-hybrid.web.app and this repository.
- Anything that lets private data leave the device without the user's choice: a way around `release()`, the type contract or the run-time guard in `src/framework/`.
- Ways to make the app say "looks safe" when it is not.

## Out of scope

- Firebase, Google Cloud and reCAPTCHA themselves: report those to Google.
- Running out of the free tier's quota.
- Findings that need a modified browser or physical access to the device.

## What to expect

- An answer within 7 days.
- Credit in the release notes, if you want it.
