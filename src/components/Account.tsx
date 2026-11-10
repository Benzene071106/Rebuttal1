"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useCases } from "./CasesProvider";
import { Badge, BUTTON, Card } from "./ui";

type Me = {
  accounts: boolean;
  seller: null | {
    id: string;
    email: string;
    shop_name: string;
    paypal: null | { env: "sandbox" | "live"; client_id: string; webhooks: boolean; connected_at: string };
  };
};

const INPUT = "w-full rounded-md border border-line bg-panel px-3 py-2 text-sm focus:border-accent focus:outline-none";

async function post(url: string, body?: unknown, method = "POST") {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setMe(await res.json());
    } catch {
      setError("Could not load your account.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!me) return <p className="text-sm text-muted">Loading…</p>;
  if (!me.accounts) return <AccountsOff />;
  return me.seller ? <SignedIn me={me} reload={load} /> : <SignInForm onDone={load} />;
}

// Shown when the server has no database: everything else works without an account.
export function AccountsOff() {
  return (
    <div className="mx-auto max-w-xl">
      <Card title="No sign-in needed for this demo">
        <p className="text-sm text-muted">
          Every page works without an account: your browser gets its own private Simulator, and the live PayPal sandbox is one click away in the top bar. Seller accounts, where a shop connects its own PayPal app, are switched off on this server because it has no database attached.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/" className={BUTTON.primary}>Open the disputes inbox</Link>
          <a href="https://github.com/KRISH-SINGH-10/Rebuttal#seller-accounts-for-real-sellers" className={BUTTON.secondary} target="_blank" rel="noreferrer">How to turn accounts on</a>
        </div>
      </Card>
    </div>
  );
}

function SignInForm({ onDone }: { onDone: () => Promise<void> }) {
  const { reload } = useCases();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await post(mode === "signin" ? "/api/auth/signin" : "/api/auth/signup", {
        email: f.get("email"),
        password: f.get("password"),
        ...(mode === "signup" ? { shop_name: f.get("shop_name") } : {}),
      });
      await onDone();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <Card title={mode === "signin" ? "Sign in" : "Create your seller account"} subtitle="Rebuttal answers the disputes on your own PayPal account.">
        <form onSubmit={submit} className="space-y-3">
          {mode === "signup" ? (
            <label className="block text-sm">
              Shop name
              <input name="shop_name" maxLength={120} className={`${INPUT} mt-1`} autoComplete="organization" />
            </label>
          ) : null}
          <label className="block text-sm">
            Email
            <input name="email" type="email" required className={`${INPUT} mt-1`} autoComplete="email" />
          </label>
          <label className="block text-sm">
            Password
            <input name="password" type="password" required minLength={mode === "signup" ? 10 : 1} className={`${INPUT} mt-1`} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
            {mode === "signup" ? <span className="text-xs text-muted">At least 10 characters.</span> : null}
          </label>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          <button type="submit" disabled={busy} className={`${BUTTON.primary} w-full`}>
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="mt-3 text-center text-sm text-muted">
          {mode === "signin" ? "New to Rebuttal? " : "Already have an account? "}
          <button className="font-medium text-accent underline" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); }}>
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </Card>
    </div>
  );
}

function SignedIn({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const router = useRouter();
  const { reload: reloadCases, switchMode } = useCases();
  const seller = me.seller!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [env, setEnv] = useState<"sandbox" | "live">(seller.paypal?.env ?? "live");
  const [editing, setEditing] = useState(!seller.paypal);

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const out = await post("/api/account/paypal", { env, client_id: f.get("client_id"), secret: f.get("secret") });
      setWarnings(out.warnings ?? []);
      setEditing(false);
      await reload();
      await switchMode("sandbox");
      await reloadCases();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect PayPal? Rebuttal stops reading and answering your disputes until you connect again. Your case history is kept.")) return;
    setBusy(true);
    try {
      await post("/api/account/paypal", undefined, "DELETE");
      await switchMode("mock");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await post("/api/auth/signout").catch(() => {});
    await reloadCases();
    router.push("/");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card title={seller.shop_name || "Your account"} subtitle={seller.email} right={<button onClick={signOut} className={BUTTON.secondary}>Sign out</button>}>
        <p className="text-sm text-muted">Your disputes, autopilot rules and history are kept for your account only.</p>
      </Card>

      <Card
        title="PayPal connection"
        subtitle="Rebuttal reads your disputes and answers them through your own PayPal app."
        right={seller.paypal ? <Badge tone="good">Connected · {seller.paypal.env === "live" ? "Live" : "Sandbox"}</Badge> : <Badge tone="warn">Not connected</Badge>}
      >
        {seller.paypal && !editing ? (
          <div className="space-y-3 text-sm">
            <p>
              App <code className="rounded bg-accent-soft px-1">{seller.paypal.client_id.slice(0, 8)}…</code>, connected {new Date(seller.paypal.connected_at).toLocaleDateString()}.
            </p>
            <p>
              {seller.paypal.webhooks ? (
                <>Dispute webhooks are on, so autopilot starts the moment a buyer opens a dispute.</>
              ) : (
                <>Dispute webhooks aren&apos;t registered, so Rebuttal checks for new disputes when you open the inbox.</>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setEditing(true)} className={BUTTON.secondary} disabled={busy}>Replace credentials</button>
              <button onClick={disconnect} className={BUTTON.ghost} disabled={busy}>Disconnect</button>
            </div>
          </div>
        ) : (
          <form onSubmit={connect} className="space-y-3 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>
                Open <a className="text-accent underline" href="https://developer.paypal.com/dashboard/applications" target="_blank" rel="noreferrer">Apps &amp; Credentials</a> in the PayPal developer dashboard, signed in with your PayPal business account.
              </li>
              <li>Pick <strong>Live</strong> (or Sandbox to try it first) and create a Merchant app, or open an existing one.</li>
              <li>Under the app&apos;s features, make sure <strong>Disputes</strong> is turned on.</li>
              <li>Copy the Client ID and Secret into the boxes below.</li>
            </ol>
            <fieldset className="flex gap-4">
              <legend className="sr-only">PayPal environment</legend>
              {(["live", "sandbox"] as const).map((e) => (
                <label key={e} className="flex items-center gap-1.5">
                  <input type="radio" name="env" checked={env === e} onChange={() => setEnv(e)} />
                  {e === "live" ? "Live (real disputes)" : "Sandbox (testing)"}
                </label>
              ))}
            </fieldset>
            <label className="block">
              Client ID
              <input name="client_id" required minLength={10} className={`${INPUT} mt-1 font-mono`} autoComplete="off" spellCheck={false} />
            </label>
            <label className="block">
              Secret
              <input name="secret" type="password" required minLength={10} className={`${INPUT} mt-1 font-mono`} autoComplete="off" />
            </label>
            <p className="text-xs text-muted">
              Your secret is encrypted before it is stored and is only used by the Rebuttal server to call PayPal for you. Money only moves when you approve, or when your autopilot rules allow it.
            </p>
            {error ? <p role="alert" className="text-danger">{error}</p> : null}
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className={BUTTON.primary}>{busy ? "Checking with PayPal…" : "Connect PayPal"}</button>
              {seller.paypal ? <button type="button" onClick={() => setEditing(false)} className={BUTTON.ghost}>Cancel</button> : null}
            </div>
          </form>
        )}
        {warnings.length ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm" style={{ color: "var(--offer)" }}>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
