import {
  Outlet,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import styles from "../styles/app.module.css";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const navigateInsideApp = (path) => (event) => {
    event.preventDefault();
    navigate(path);
  };

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app" onClick={navigateInsideApp("/app")}>Übersicht</s-link>
        <s-link href="/app/motifs" onClick={navigateInsideApp("/app/motifs")}>Motive</s-link>
        <s-link href="/app/categories" onClick={navigateInsideApp("/app/categories")}>Kategorien</s-link>
        <s-link href="/app/colors" onClick={navigateInsideApp("/app/colors")}>Farben</s-link>
        <s-link href="/app/fonts" onClick={navigateInsideApp("/app/fonts")}>Schriften</s-link>
      </s-app-nav>
      <div className={styles.appContent} aria-busy={isLoading}>
        {isLoading && (
          <div className={styles.loadingLayer} role="status" aria-live="polite">
            <div className={styles.loadingBar}></div>
            <div className={styles.loadingNotice}>
              <span className={styles.spinner} aria-hidden="true"></span>
              <span>Inhalt wird geladen …</span>
            </div>
          </div>
        )}
        <Outlet />
      </div>
    </AppProvider>
  );
}

export const shouldRevalidate = ({ formMethod, defaultShouldRevalidate }) =>
  formMethod ? defaultShouldRevalidate : false;

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
