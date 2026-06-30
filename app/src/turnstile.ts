// Cloudflare Turnstile — server-side verifiering av widget-token (aldrig från
// browsern). Token kommer från cf-turnstile-response-fältet i formuläret.
// Returnerar true om verifieringen lyckas. Fail-open när ingen secret är
// konfigurerad (dev/preview utan TURNSTILE_SECRET) så signup inte låser sig;
// i produktion är secreten satt och skyddet aktivt.
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp?: string | null,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) return false;
  const data = await resp.json<{ success: boolean }>();
  return data.success === true;
}
