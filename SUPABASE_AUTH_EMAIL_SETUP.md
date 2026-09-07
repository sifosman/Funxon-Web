# Supabase Auth Email — Dashboard Setup (paste-ready)

> **Why this file exists:** the auth email sender, templates and redirect URLs live in
> GoTrue (Supabase Auth service) config, which is **not reachable via SQL / the Supabase
> MCP** — it must be changed in the Supabase Dashboard (or via the Management API with a
> personal access token). This doc contains the exact values to paste. ~10 minutes.
>
> **What this fixes:** bug-report items 1–3 (email "from Supabase", junk mail, scary
> security warning on the verify link) — *except* the sender address itself, which needs
> Brevo SMTP credentials (out of scope per instruction). Until custom SMTP is enabled,
> emails still arrive from Supabase's shared sender, but with Funxon branding and
> working redirects.

---

## 1. URL Configuration (Authentication → URL Configuration)

| Setting | Value |
|---|---|
| **Site URL** | `https://funxon.co.za` |
| **Redirect URLs** (add any missing) | `https://funxon.co.za/**` |
| | `https://funxon.co.za/auth/callback` |
| | `funxon://**` |
| | `https://auth.expo.io/@sifosman/funxon/auth/callback` |

Rationale: the app builds confirmation redirects with
`Linking.createURL('auth/callback/<role>')` (`src/screens/SignUpScreen.tsx:70`) — that
resolves to `https://funxon.co.za/auth/callback/...` on web and `funxon://...` on native.
The Expo auth proxy URL is used for native OAuth (`src/auth/AuthContext.tsx:549`).

⚠️ Do **not** remove existing entries that are currently listed — only add missing ones.

## 2. Email Templates (Authentication → Emails → Templates)

Paste the HTML below into the **Confirmation** template (and adapt the last section for
**Reset Password** — same wrapper, different action text). Both use Supabase's standard
variables: `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .Email }}`.

### Confirmation template (Confirm signup)

**Subject:** `Confirm your Funxon email address`

**Body:**

```html
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;padding:40px;">
            <tr>
              <td style="text-align:center;padding-bottom:24px;">
                <span style="font-size:26px;font-weight:bold;color:#0f766e;letter-spacing:1px;">FUNXON</span>
              </td>
            </tr>
            <tr>
              <td style="text-align:center;padding-bottom:8px;">
                <h1 style="margin:0;font-size:22px;color:#111827;">Confirm your email address</h1>
              </td>
            </tr>
            <tr>
              <td style="text-align:center;padding-bottom:24px;">
                <p style="margin:0;font-size:15px;line-height:22px;color:#4b5563;">
                  Welcome to Funxon! Tap the button below to confirm your email address
                  (<strong>{{ .Email }}</strong>) and activate your account.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <a href="{{ .ConfirmationURL }}"
                   style="display:inline-block;background-color:#0f766e;color:#ffffff;
                          font-size:15px;font-weight:bold;text-decoration:none;
                          padding:14px 32px;border-radius:8px;">
                  Verify my email
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:8px;">
                <p style="margin:0;font-size:13px;line-height:20px;color:#6b7280;">
                  Or copy and paste this link into your browser:
                </p>
                <p style="margin:0;font-size:12px;word-break:break-all;color:#0f766e;">
                  {{ .ConfirmationURL }}
                </p>
              </td>
            </tr>
            <tr>
              <td style="border-top:1px solid #e5e7eb;padding-top:16px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:#9ca3af;">
                  This is an official email from Funxon (funxon.co.za). When you tap the
                  button you will be taken to funxon.co.za to finish signing in — that is
                  expected and safe. If you didn't create a Funxon account, you can safely
                  ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
```

### Reset Password template (same wrapper, change these parts)

- **Subject:** `Reset your Funxon password`
- Heading: `Reset your password`
- Paragraph: `Tap the button below to choose a new password for your Funxon account`
- Button text: `Reset my password`

### Reauthentication / Magic Link templates

Leave as-is unless used; if used, apply the same FUNXON header + footer wrapper.

## 3. Sender address (later, needs Brevo — out of scope today)

Authentication → SMTP Settings → Enable Custom SMTP, using Brevo's SMTP relay:
host `smtp-relay.brevo.com`, port `587`, username = Brevo account email,
password = a Brevo **SMTP key** (Brevo → SMTP & API → SMTP tab — different from the
`xkeysib-` API key used by the edge functions), sender `noreply@funxon.co.za` /
name `Funxon`. Also authenticate the `funxon.co.za` domain in Brevo (DKIM/DMARC) —
that is what moves mail out of junk. Brevo free tier = 300 emails/day.

## 4. Test checklist (after pasting)

1. Sign up on web with a fresh address → confirmation email arrives, Funxon-branded.
2. Tap the verify button → lands on `funxon.co.za/auth/callback/...` and signs in.
3. Sign up on the native app → verify link opens the app via `funxon://` deep link.
4. Password reset flow → same branded template, redirect works.
5. Ask one real user to check whether it lands in Junk (fully fixed only once
   custom SMTP + domain authentication from step 3 are in place).
