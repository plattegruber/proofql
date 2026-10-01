// The project's front door is its reviews.
import { redirect } from "react-router";
import type { Route } from "./+types/app.projects.$slug._index";

export function loader({ params }: Route.LoaderArgs) {
  return redirect(`/app/projects/${params.slug}/reviews`);
}
