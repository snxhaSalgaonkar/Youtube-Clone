import { AuthProvider } from "@/context/AuthContext";
import "./globals.css";

export const metadata = {
  title: "YouTube Clone",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {/*
          AuthProvider wraps everything.
          This means every page and component can call useAuth()
          and get the current user instantly without an extra API call.
        */}
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
