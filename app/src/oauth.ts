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
  // GitHub stödjer bara EN callback-URL per OAuth-app — länkflödet återanvänder
  // login-callbacken och kodar "link:<accountId>" i state-värdet istället.
  sharesLoginCallback?: boolean;
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
    sharesLoginCallback: true,
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
const REDIRECT_BASE_LINK = "https://politiker.denied.se/api/oauth-link";

export function providerSharesLoginCallback(provider: string): boolean {
  return !!PROVIDERS[provider]?.sharesLoginCallback;
}

export function getLinkAuthorizeUrl(provider: string, env: Env, state: string): string {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error("Okänd leverantör");
  const clientId = env[cfg.clientIdEnvKey] as string | undefined;
  if (!clientId) throw new Error(`${provider}-inloggning är inte konfigurerad än`);

  // Leverantörer med sharesLoginCallback återanvänder login-redirect-URI:n.
  const redirectUri = cfg.sharesLoginCallback
    ? `${REDIRECT_BASE}/${provider}/callback`
    : `${REDIRECT_BASE_LINK}/${provider}/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

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

async function exchangeCodeForUserInfo(
  provider: string,
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ providerUserId: string; email: string }> {
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
      redirect_uri: redirectUri,
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

  return { providerUserId, email };
}

export async function handleOAuthCallback(
  provider: string,
  env: Env,
  code: string,
): Promise<{ accountId: string }> {
  const { providerUserId, email } = await exchangeCodeForUserInfo(provider, env, code, `${REDIRECT_BASE}/${provider}/callback`);

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

// Länkar en YTTERLIGARE leverantör till ett REDAN INLOGGAT konto — till
// skillnad från handleOAuthCallback matchar denna ALDRIG på e-post och
// skapar ALDRIG ett nytt konto. Om leverantörsidentiteten redan är kopplad
// till ett ANNAT konto avvisas länkningen explicit.
export async function handleOAuthLinkCallback(provider: string, env: Env, code: string, currentAccountId: string): Promise<void> {
  const cfg = PROVIDERS[provider];
  const redirectUri = cfg?.sharesLoginCallback
    ? `${REDIRECT_BASE}/${provider}/callback`
    : `${REDIRECT_BASE_LINK}/${provider}/callback`;
  const { providerUserId } = await exchangeCodeForUserInfo(provider, env, code, redirectUri);

  const existingIdentity = await env.DB.prepare("SELECT account_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?")
    .bind(provider, providerUserId)
    .first<{ account_id: string }>();
  if (existingIdentity) {
    if (existingIdentity.account_id === currentAccountId) return; // redan länkat till samma konto, inget att göra
    throw new Error(`Det här ${provider}-kontot är redan kopplat till ett annat politiker-webapp-konto`);
  }

  await env.DB.prepare("INSERT INTO oauth_identities (id, account_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(randomId(), currentAccountId, provider, providerUserId, Date.now())
    .run();
}

export async function getOAuthIdentities(env: Env, accountId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT provider FROM oauth_identities WHERE account_id = ?")
    .bind(accountId)
    .all<{ provider: string }>();
  return results.map((r) => r.provider);
}

// Tar bort en länkad leverantör — men aldrig den SISTA inloggningsvägen ett
// konto har (om inget lösenord är satt och bara en leverantör är länkad,
// skulle borttagning låsa ute användaren permanent).
export async function unlinkOAuthIdentity(env: Env, accountId: string, provider: string): Promise<void> {
  const account = await env.DB.prepare("SELECT password_set_by_user FROM accounts WHERE id = ?").bind(accountId).first<{ password_set_by_user: number }>();
  const identities = await getOAuthIdentities(env, accountId);
  const hasUsablePassword = !!account?.password_set_by_user;

  if (!hasUsablePassword && identities.length <= 1) {
    throw new Error("Det här är ditt enda sätt att logga in — sätt ett lösenord innan du tar bort den här kopplingen");
  }

  await env.DB.prepare("DELETE FROM oauth_identities WHERE account_id = ? AND provider = ?").bind(accountId, provider).run();
}
