# 🚀 Expiry Notifier — SaaS Reminder System

Expiry Notifier is a multi-tenant SaaS platform that allows businesses to send automated Email and SMS reminders to customers.

It is designed for Indian SMBs and supports usage tracking, billing plans, admin analytics, and manual payment workflows (UPI / Bank / International).

---

## 📌 What This Project Does

This system allows:

### 🏢 Tenants (Businesses) to:
- Send Email & SMS reminders
- Track reminder delivery status
- View usage & plan limits
- Upgrade plans (Starter / Business)
- Submit payment notifications

### 👑 Admin to:
- View platform analytics
- Monitor tenants
- Track purchases
- View revenue metrics
- Retry failed jobs
- Export tenant data

---

## 🧠 Core Features

- 🔐 JWT-based authentication
- 📧 Email sending (SendGrid)
- 📱 SMS sending (Twilio)
- 📊 Usage tracking & job logs
- 💳 Plan-based reminder limits
- 🧾 Manual billing system (UPI / Bank / PayPal)
- 📈 Admin dashboard with analytics charts
- 🏢 Multi-tenant architecture
- 🔄 Retry mechanism for failed reminders

---

## 🏗 Tech Stack

### 🔹 Backend
- Node.js
- Express.js
- PostgreSQL
- JWT Authentication
- SendGrid API (Email)
- Twilio API (SMS)
- Docker (Postgres container)

### 🔹 Frontend
- HTML
- TailwindCSS
- Vanilla JavaScript
- Chart.js (Admin analytics)

### 🔹 Infrastructure
- Docker (Postgres)
- GitHub
- Environment variables (.env)

---

## 📂 Project Structure
Reminder-system/
│
├── backend/
│ ├── server.js
│ ├── routes/
│ ├── services/
│ ├── models/
│ └── db.js
│
├── frontend/
│ ├── index.html
│ ├── home.html
│ ├── tenant.html
│ └── admin.html
│
├── .env.example
├── package.json
└── README.md

---

## ⚙️ Environment Variables

Create a `.env` file in the root:
PORT=3000
DATABASE_URL=postgres://postgres:password@localhost:5432/expirydb
JWT_SECRET=your_secret_key

SENDGRID_API_KEY=your_sendgrid_key
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token


⚠️ Never commit `.env` to GitHub.

---

## 🐳 Setup PostgreSQL (Docker)

Run:
docker run --name notify-postgres
-e POSTGRES_USER=postgres
-e POSTGRES_PASSWORD=postgres123
-e POSTGRES_DB=expirydb
-p 5432:5432
-d postgres:15-alpine

---

## 🚀 How To Run The Application

### 1️⃣ Install dependencies
npm install

### 2️⃣ Start the server
node server.js

Or with nodemon:
npx nodemon server.js

Server will start at:
http://localhost:3000

---

## 🌐 Application Pages

| Page | URL | Description |
|------|------|-------------|
| Login | `/` | User authentication |
| Dashboard | `/index.html` | Send reminders |
| Home | `/home.html` | Pricing & overview |
| Tenant | `/tenant.html` | Usage & billing |
| Admin | `/admin.html` | Admin analytics |

---

## 💳 Pricing Plans

| Plan | Price | Limit |
|------|-------|-------|
| Free | ₹0 | 100 reminders |
| Starter | ₹999 | 2,000 reminders |
| Business | ₹3,999 | 10,000 reminders |

---

## 🔐 Security Notes

- JWT authentication
- Environment variable protection
- No secrets committed
- Admin protected routes
- Server-side usage validation

---

## 📊 Admin Dashboard Features

- Real-time KPIs
- Revenue tracking
- Purchase monitoring
- Channel distribution charts
- Tenant search & export
- Retry failed jobs

---

## 🧩 Future Improvements

- Automated payment gateway integration (Razorpay / Stripe)
- Email verification flow
- Scheduled recurring reminders
- Webhook-based retry system
- Role-based access control
- SaaS subscription automation

---

## 👨‍💻 Author

Built by Reyan Das  
Designed as a production-ready SaaS reminder platform.

---

## By Reyan
