"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import api from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  const [formData, setFormData] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); // prevents page reload on form submit
    setError("");
    setLoading(true);

    try {
      const res = await api.post("/users/login", formData);

      /*
        res.data.data.user  → the logged in user object
        The accessToken and refreshToken cookies are set automatically
        by the browser because your backend uses res.cookie()
        You don't manually store them anywhere
      */
      login(res.data.data.user);
      router.push("/"); // redirect to home
    } catch (err) {
      // err.response.data.message is the message from your ApiError
      setError(err.response?.data?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Sign In</h1>
        <p style={styles.subtitle}>to continue to YouTube Clone</p>

        {error && <p style={styles.error}>{error}</p>}

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            style={styles.input}
            type="email"
            name="email"
            placeholder="Email"
            value={formData.email}
            onChange={handleChange}
            required
          />
          <input
            style={styles.input}
            type="password"
            name="password"
            placeholder="Password"
            value={formData.password}
            onChange={handleChange}
            required
          />
          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p style={styles.registerText}>
          New here?{" "}
          <Link href="/register" style={styles.link}>
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0f0f0f",
  },
  card: {
    backgroundColor: "#1f1f1f",
    padding: "40px",
    borderRadius: "12px",
    width: "100%",
    maxWidth: "400px",
    border: "1px solid #333",
  },
  title: { color: "#fff", fontSize: "24px", marginBottom: "4px" },
  subtitle: { color: "#aaa", fontSize: "14px", marginBottom: "24px" },
  error: {
    backgroundColor: "#3d1a1a",
    color: "#ff6b6b",
    padding: "10px",
    borderRadius: "6px",
    marginBottom: "16px",
    fontSize: "14px",
  },
  form: { display: "flex", flexDirection: "column", gap: "16px" },
  input: {
    padding: "12px",
    borderRadius: "6px",
    border: "1px solid #444",
    backgroundColor: "#2a2a2a",
    color: "#fff",
    fontSize: "14px",
    outline: "none",
  },
  button: {
    padding: "12px",
    backgroundColor: "#ff0000",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontSize: "16px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  registerText: {
    color: "#aaa",
    textAlign: "center",
    marginTop: "20px",
    fontSize: "14px",
  },
  link: { color: "#ff0000", textDecoration: "none" },
};
