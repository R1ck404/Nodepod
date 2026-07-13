import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

export default function Home(): JSX.Element {
  return (
    <section className="mx-auto flex max-w-4xl flex-col items-center justify-center px-6 py-24">
      <Card className="w-full max-w-lg text-center">
        <CardHeader>
          <CardTitle className="text-3xl">Welcome back</CardTitle>
          <CardDescription>
            You are signed in. Describe what you want in the chat and Scelar will
            build it here — with real SQLite-backed data and coss UI components.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </section>
  );
}
