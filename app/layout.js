import "./globals.css";
import { ProductNav } from "@/components/ProductNav";

export const metadata = {
  title: "Ajace Timesheets",
  description: "AI-assisted timesheet capture & review",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ProductNav current="timesheet" />
        {children}
      </body>
    </html>
  );
}
