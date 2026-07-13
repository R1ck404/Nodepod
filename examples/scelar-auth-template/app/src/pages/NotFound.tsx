import { Link } from "react-router";

export default function NotFound(): JSX.Element {
  return (
    <section className="mx-auto flex max-w-4xl flex-col items-center px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The page you are looking for does not exist.
      </p>
      <Link
        to="/"
        className="mt-6 text-sm text-foreground underline-offset-4 hover:underline"
      >
        Back home
      </Link>
    </section>
  );
}
