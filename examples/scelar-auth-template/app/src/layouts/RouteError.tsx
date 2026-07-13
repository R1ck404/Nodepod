import { Link, useRouteError } from "react-router";

export default function RouteError() {
  const error = useRouteError();
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Something went wrong";

  return (
    <section className="mx-auto flex max-w-4xl flex-col items-center px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold">Unexpected error</h1>
      <p className="mt-3 max-w-md text-sm text-muted-foreground">{message}</p>
      <Link
        to="/"
        className="mt-6 text-sm text-foreground underline-offset-4 hover:underline"
      >
        Back home
      </Link>
    </section>
  );
}
