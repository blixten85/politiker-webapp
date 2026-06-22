import { randomId, hashPassword } from "../../shared/crypto";
import { getAccountByEmail, type Env } from "./db";

// Apple ("Sign in with Apple") hanteras INTE här ännu — Apple kräver en
// JWT-signerad client secret (ES256, roterande) istället för en statisk
// hemlighet, vilket kräver ett Apple Developer-konto + nyckelgenerering.
// Google/GitHub/Microsoft delar ett standard OAuth2 authorization-code-flöde.

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientIdEnvKey: keyof Env;
  clientSecretEnvKey: keyof Env;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope: "openid email profile",
    clientIdEnvKey: "OAUTH_GOOGLE_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_GOOGLE_CLIENT_SECRET",
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    scope: "read:user user:email",
    clientIdEnvKey: "OAUTH_GITHUB_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_GITHUB_CLIENT_SECRET",
  },
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scope: "openid email profile",
    clientIdEnvKey: "OAUTH_MICROSOFT_CLIENT_ID",
    clientSecretEnvKey: "OAUTH_MICROSOFT_CLIENT_SECRET",
  },
};

const REDIRECT_BASE = "https://politiker.denied.se/api/oauth";

export function getAuthorizeUrl(provider: string, env: Env, state: string): string {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd leverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  if (!clientId) throw new Error(`${provider}-inloggning är inte konfigurerad än`);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${REDIRECT_BASE}/${provider}/callback`,
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

export async function handleOAuthCallback(
  provider: string,
  env: Env,
  code: string,
): Promise<{ accountId: string }> {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd leverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  const clientSecret = env[cfg.clientSecretEnvKey] as string | undefined;
  if (!clientId || !clientSecret) throw new Error(`${provider}-inloggning är inte konfigurerad än`);

  const tokenResp = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${REDIRECT_BASE}/${provider}/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) throw new Error(`Kunde inte hämta access token från ${provider}`);
  const tokenData = await tokenResp.json<{ access_token: string }>();

  const userResp = await fetch(cfg.userinfoUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "politiker-webapp" },
  });
  if (!userResp.ok) throw new Error(`Kunde inte hämta användarinfo från ${provider}`);
  const userData = await userResp.json<Record<string, unknown>>();

  const providerUserId = String(userData.sub ?? userData.id);
  let email = (userData.email as string | undefined) ?? null;

  // GitHub ger inte alltid email i /user — hämta från /user/emails om saknas
  if (!email && provider === "github") {
    const emailsResp = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "politiker-webapp" },
    });
    if (emailsResp.ok) {
      const emails = await emailsResp.json<Array<{ email: string; primary: boolean }>>();
      email = emails.find((e) => e.primary)?.email ?? emails[0]?.email ?? null;
    }
  }
  if (!email) throw new Error(`Kunde inte hämta e-postadress från ${provider}`);

  const existingIdentity = await env.DB.prepare("SELECT account_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?")
    .bind(provider, providerUserId)
    .first<{ account_id: string }>();
  if (existingIdentity) return { accountId: existingIdentity.account_id };

  // Ingen koppling än — länka till befintligt konto med samma e-post, eller skapa nytt.
  let account = await getAccountByEmail(env.DB, email);
  let accountId: string;
  if (account) {
    accountId = account.id as string;
  } else {
    accountId = randomId();
    const { hash, salt } = await hashPassword(randomId() + randomId()); // oanvändbart slumpat lösenord
    await env.DB.prepare(
      `INSERT INTO accounts (id, email, password_hash, password_salt, email_verified, daily_send_cap, created_at)
       VALUES (?, ?, ?, ?, 1, 200, ?)`,
    )
      .bind(accountId, email, hash, salt, Date.now())
      .run();
  }

  await env.DB.prepare("INSERT INTO oauth_identities (id, account_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(randomId(), accountId, provider, providerUserId, Date.now())
    .run();

  return { accountId };
}
