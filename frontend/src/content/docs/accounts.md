# Accounts

An account is a person: a name, an email address, and a password. One account can belong to any number of
projects.

## Signing in and out

[Sign in](/sign-in) with your email and password. A wrong password and an unknown email get the same answer, on
purpose, so the form cannot be used to find out who has an account.

A session lasts a day and survives closing the tab. **Sign out** is at the bottom of the account menu, in the
sidebar's foot.

## Changing your details

Open **Account** from the account menu (or **Go to Account** in ⌘K) to change your name, your email, or your
password. Only the fields you changed are sent. Leave the password box empty to keep your current one; a new
password needs at least eight characters.

Your email must not belong to another account. Invitations are matched to accounts by email, so an invite sent to
your old address will not reach you after you change it.

## Signing in the CLI

The `hypotenuse` CLI signs in through this site rather than asking for your password: `hypotenuse login` opens a
page here where you click **Approve**. **Account → CLI sign-ins** lists every CLI signed in as you, and **Revoke**
signs one out. See [the CLI](/docs/cli).

## Notifications

Hypotenuse tells you when something needs you. Each notification appears:

- under the **bell** in the sidebar, with an unread count, and as a toast in the corner of an open page — live, with
  no reload; and
- by **email**, when the deployment has a mail server configured.

Opening a notification marks it read and takes you to the page it is about. **Mark all read** clears the count. You
can also turn on **desktop notifications** from the bell; Hypotenuse only ever asks for that permission when you click
the button, and shows a desktop notification only while the tab is in the background.

## Theme

Choose **Light**, **Dark**, or **System** in the account menu or in ⌘K. The choice belongs to the browser, so each
device keeps its own.
