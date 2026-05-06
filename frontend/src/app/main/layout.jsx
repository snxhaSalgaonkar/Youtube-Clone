"use client";
import { useAuth } from "@/context/AuthContext";

export default function MainLayout({ children }) {
  const { user, logout, loading } = useAuth();

  if (loading) return <div style={styles.loading}>Loading...</div>;

  return (
    <div>
      <nav style={styles.nav}>
        <span style={styles.logo}>▶ YouTube Clone</span>
        <div style={styles.navRight}>
          {user ? (
            <>
              <span style={styles.username}>Hi, {user.fullname}</span>
              <button style={styles.logoutBtn} onClick={logout}>
                Logout
              </button>
            </>
          ) : null}
        </div>
      </nav>
      <main style={styles.main}>{children}</main>
    </div>
  );
}

const styles = {
  nav: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 24px",
    backgroundColor: "#0f0f0f",
    borderBottom: "1px solid #333",
  },
  logo: { color: "#ff0000", fontSize: "20px", fontWeight: "bold" },
  navRight: { display: "flex", alignItems: "center", gap: "16px" },
  username: { color: "#fff", fontSize: "14px" },
  logoutBtn: {
    padding: "8px 16px",
    backgroundColor: "transparent",
    color: "#ff0000",
    border: "1px solid #ff0000",
    borderRadius: "6px",
    cursor: "pointer",
  },
  loading: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0f0f0f",
    color: "#fff",
  },
  main: {
    backgroundColor: "#0f0f0f",
    minHeight: "calc(100vh - 57px)",
    padding: "24px",
  },
};
