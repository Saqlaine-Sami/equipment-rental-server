require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 5000;

// ---------- Middleware ----------
app.use(
  cors({
    origin: [process.env.CLIENT_URL, "http://localhost:3000"].filter(Boolean),
    credentials: true,
  })
);
app.use(express.json());

// ---------- MongoDB Connection ----------
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

let db;
async function getDB() {
  if (!db) {
    await client.connect();
    db = client.db(process.env.DB_NAME);
    console.log("MongoDB connected");
  }
  return db;
}

// সব collection এক জায়গা থেকে নেওয়ার function
async function getCollections() {
  const database = await getDB();
  return {
    users: database.collection("users"),
    equipment: database.collection("equipment"),
    bookings: database.collection("bookings"),
    favorites: database.collection("favorites"),
    payments: database.collection("payments"),
    reviews: database.collection("reviews"),
  };
}

// ---------- JWT & Role Middlewares ----------

// ১. Token যাচাই: সঠিক token ছাড়া কেউ ঢুকতে পারবে না
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded; // এখানে { email } থাকবে
    next();
  });
};

// ২. Role যাচাই: database থেকে user-এর আসল role দেখে
const verifyRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const { users } = await getCollections();
      const user = await users.findOne({ email: req.decoded.email });

      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).send({ message: "forbidden access" });
      }

      req.user = user;
      next();
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  };
};

const verifyRenter = verifyRole("customer");
const verifyOwner = verifyRole("owner");
const verifyAdmin = verifyRole("admin");

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send("Equipment Rental Platform Server is running");
});

// Database connection test (শুধু যাচাইয়ের জন্য)
app.get("/health", async (req, res) => {
  try {
    const database = await getDB();
    await database.command({ ping: 1 });
    res.send({ status: "ok", database: "connected" });
  } catch (error) {
    res.status(500).send({ status: "error", message: error.message });
  }
});

// ---------- Start ----------
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;