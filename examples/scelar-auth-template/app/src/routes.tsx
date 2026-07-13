import { createBrowserRouter } from "react-router";
import RootLayout from "./layouts/RootLayout";
import RouteError from "./layouts/RouteError";
import RequireAuth from "./components/RequireAuth";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import NotFound from "./pages/NotFound";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    ErrorBoundary: RouteError,
    children: [
      {
        index: true,
        Component: () => (
          <RequireAuth>
            <Home />
          </RequireAuth>
        ),
      },
      { path: "login", Component: Login },
      { path: "signup", Component: Signup },
      { path: "*", Component: NotFound },
    ],
  },
]);
