// "prepare" script: installs the husky git hooks on `npm install`.
// Skipped on CI/production installs and when husky isn't installed (e.g. --omit=dev).
if (process.env.NODE_ENV === "production" || process.env.CI) process.exit(0);

try {
  const husky = (await import("husky")).default;
  const message = husky();
  if (message) console.log(message);
} catch {
  // husky isn't installed - nothing to set up
}
