/**
 * The browser suite's mail catcher, run as its own process by
 * `frontend/scripts/e2e-backend.ts` (the frontend may not import backend code,
 * so it starts this by path instead). It is the fake SMTP server the backend
 * suites use, bound to `SMTP_PORT`, plus an HTTP inbox on `E2E_MAIL_INBOX_PORT`
 * answering `GET /verification-token?to=` with the token from the newest
 * verification mail to that address — so a spec follows the link the real
 * mail carried rather than minting one.
 */
import { startFakeSmtpServer, verificationTokenIn } from "./smtp";

const smtp = startFakeSmtpServer(Number(process.env.SMTP_PORT));
const inbox = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.E2E_MAIL_INBOX_PORT),
  fetch(request) {
    const to = new URL(request.url).searchParams.get("to") ?? "";
    const mail = smtp.received.findLast(
      (m) => m.to.includes(to) && m.subject.includes("Confirm your"),
    );
    const token = mail ? verificationTokenIn(mail) : undefined;
    return Response.json({ token: token ?? null });
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    smtp.stop();
    inbox.stop(true);
    process.exit(0);
  });
}
