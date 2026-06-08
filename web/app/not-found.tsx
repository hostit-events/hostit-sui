import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 py-8 flex items-center justify-center">
      <div className="card text-center" style={{ maxWidth: 440 }}>
        <div className="mono" style={{ color: "var(--fg3)" }}>
          404
        </div>
        <h1 className="font-semibold" style={{ fontSize: 22, marginTop: 6 }}>
          Page not found
        </h1>
        <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 6 }}>
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <Link href="/discover" className="btn btn-primary" style={{ marginTop: 18 }}>
          Back to Discover
        </Link>
      </div>
    </main>
  );
}
