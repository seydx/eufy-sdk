/**
 * Strip a token the gateway echoed back into its own error message.
 *
 * `"token not exist, token = <the rejected token>"` is the vendor's wording, and that message travels into the
 * error the SDK surfaces. A credential that has just been rejected is still a credential, and it is
 * never the part of the message that explains anything.
 */
export function withoutTokenEcho(text: string): string {
  return text.replace(/token\s*[=:]\s*"?[A-Za-z0-9._-]{8,}"?/gi, "token = <redacted>");
}
