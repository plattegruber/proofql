// "/" is marketing-free (#36): the dashboard is the front door.
import { redirect } from "react-router";

export function loader() {
  return redirect("/app");
}
