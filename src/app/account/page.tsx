import { connection } from "next/server";
import { Suspense } from "react";
import Account, { AccountsOff } from "@/components/Account";
import { accountsEnabled } from "@/lib/auth/sellers";

export const metadata = { title: "Account · Rebuttal" };

export default function AccountPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <AccountGate />
    </Suspense>
  );
}

// Decided on the server, so a server without a database says so in the first HTML
// instead of waiting on the browser to ask.
async function AccountGate() {
  await connection();
  return accountsEnabled() ? <Account /> : <AccountsOff />;
}
