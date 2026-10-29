# Accounts

An account is you: a name, an email address, and a password. Your email is how teammates invite you, and it is
compared without regard to case, so `Ana@Example.com` and `ana@example.com` are the same account.

## Signing up

Sign up with your name, your email, and a password of at least eight characters. Signing up also sets up a place to
work, all at once:

- an **organization** named after you, which you **own**;
- a first **project** in it, called **Default**, where you are an **admin**.

We email you a link to confirm your address. Follow it — on any device; you do not need to be signed in there — and
press **Confirm my address**. Until you do, a banner across the top of every page says so, and you cannot see or
answer invitations: they are addressed by email, so they belong to whoever reads that inbox, not to whoever typed the
address first. The link works once, for one day. If it has expired or never arrived, **Send a new link** in the banner
mails another (at most one a minute).

If someone invited you before you had an account, their invitation is waiting under **Invites** as soon as you
confirm your address — accept it there, and you join their organization too. See
[Organizations](/docs/organizations).

## Signing in and out

Sign in with your email and password. A wrong password and an unknown email give the same answer, so nobody can use
the sign-in page to find out who has an account. Sign out from the account menu at the bottom of the sidebar.

## Changing your details

**Account** (in the account menu) changes your name, your email, or your password. Changing your email or your
password asks for your current password too, so a session left open on someone else's screen cannot lock you out.
Changing your password does not sign you out where you are.

A new email does not take effect when you save. We email a link to the new address, and your account keeps the old
one — for signing in, and for invitations — until you follow it. Until then **Account** shows the change as pending,
with **Send a new link** and **Keep** (your current address), which withdraws it. A new email must not already belong
to another account, both when you ask for it and when you confirm it.

## Invites

**Invites** lists every pending invitation addressed to your email — to an organization, or to a project inside one —
once that email is confirmed.
Accept one to join; reject one to decline it, and the person who sent it sees that you did. An invitation expires
after five days; ask for a new one if yours has.

## CLI sign-ins

**Account → CLI sign-ins** lists every `hypotenuse` command line signed in as you: the machine's name, the last four
characters of its sign-in, when it signed in, when it was last used, and when it lapses. **Revoke** signs that
machine out; its next command is refused and asks it to sign in again. See [Command line](/docs/cli).

