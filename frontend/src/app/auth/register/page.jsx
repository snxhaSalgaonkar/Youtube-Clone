"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import api from "@/lib/api";

export default function RegisterPage() {
  const router = useRouter();

  const [formData, setFormData] = useState({
    fullname: "",
    username: "",
    email: "",
    password: "",
  });
  const [avatar, setAvatar] = useState(null);
  const [coverImage, setCoverImage] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!avatar) {
      setError("Avatar is required");
      return;
    }

    setLoading(true);

    try {
      /*
        Your backend uses multer and expects multipart/form-data
        NOT application/json
        FormData is the browser's way of sending files + text together
      */
      const data = new FormData();
      data.append("fullname", formData.fullname);
      data.append("username", formData.username);
      data.append("email", formData.email);
      data.append("password", formData.password);
      data.append("avatar", avatar);
      if (coverImage) data.append("coverImage", coverImage);

      await api.post("/users/register", data, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      // Registration successful → send to login
      router.push("/login?registered=true");
    } catch (err) {
      setError(err.response?.data?.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Create Account</h1>

        {error && <p style={styles.error}>{error}</p>}

        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            style={styles.input}
            name="fullname"
            placeholder="Full Name"
            onChange={handleChange}
            required
          />
          <input
            style={styles.input}
            name="username"
            placeholder="Username"
            onChange={handleChange}
            required
          />
          <input
            style={styles.input}
            type="email"
            name="email"
            placeholder="Email"
            onChange={handleChange}
            required
          />
          <input
            style={styles.input}
            type="password"
            name="password"
            placeholder="Password"
            onChange={handleChange}
            required
          />

          <div>
            <label style={styles.label}>Avatar (required)</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setAvatar(e.target.files[0])}
              style={styles.fileInput}
              required
            />
          </div>

          <div>
            <label style={styles.label}>Cover Image (optional)</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setCoverImage(e.target.files[0])}
              style={styles.fileInput}
            />
          </div>

          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <p style={styles.loginText}>
          Already have an account?{" "}
          <Link href="/login" style={styles.link}>
            Sign in
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
  title: { color: "#fff", fontSize: "24px", marginBottom: "24px" },
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
  },
  label: {
    color: "#aaa",
    fontSize: "13px",
    display: "block",
    marginBottom: "6px",
  },
  fileInput: { color: "#aaa", fontSize: "13px" },
  button: {
    padding: "12px",
    backgroundColor: "#ff0000",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontSize: "16px",
    cursor: "pointer",
  },
  loginText: {
    color: "#aaa",
    textAlign: "center",
    marginTop: "20px",
    fontSize: "14px",
  },
  link: { color: "#ff0000", textDecoration: "none" },
};
