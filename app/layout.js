import "./globals.css";

export const metadata = {
  title: "Ajace Timesheets",
  description: "AI-assisted timesheet capture & review",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
