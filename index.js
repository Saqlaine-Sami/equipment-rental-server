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
const verifyOwnerOrAdmin = verifyRole("owner", "admin");
const verifyAnyUser = verifyRole("customer", "owner", "admin");

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

// ---------- Users & Auth Routes ----------

// নতুন user সেভ (Register ও Google login দুটোতেই ব্যবহার হবে)
app.post("/users", async (req, res) => {
  try {
    const { name, email, photo } = req.body;

    if (!email) {
      return res.status(400).send({ message: "email is required" });
    }

    const { users } = await getCollections();

    const existingUser = await users.findOne({ email });
    if (existingUser) {
      return res.send({ message: "user already exists", insertedId: null });
    }

    const newUser = {
      name: name || "",
      email,
      photo: photo || "",
      phone: "",
      address: "",
      role: "customer", // সবসময় customer, request থেকে role নেওয়া হবে না
      createdAt: new Date(),
    };

    const result = await users.insertOne(newUser);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// JWT token তৈরি (login সফল হলে Client এটা ডাকবে)
app.post("/jwt", async (req, res) => {
  try {
    const { email } = req.body;

    const { users } = await getCollections();
    const user = await users.findOne({ email });

    if (!user) {
      return res.status(404).send({ message: "user not found" });
    }

    const token = jwt.sign({ email }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.send({ token });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// বর্তমান logged-in user-এর তথ্য ও role
app.get("/users/me", verifyToken, async (req, res) => {
  try {
    const { users } = await getCollections();
    const user = await users.findOne({ email: req.decoded.email });

    if (!user) {
      return res.status(404).send({ message: "user not found" });
    }

    res.send(user);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// ---------- Equipment Routes ----------

const EQUIPMENT_CATEGORIES = [
  "Construction Equipment",
  "Photography Equipment",
  "Vehicles & Transportation",
  "Agriculture Equipment",
  "Electronics",
  "Event Equipment",
];
const RENTAL_TYPES = ["Daily", "Weekly", "Monthly"];
const EQUIPMENT_STATUSES = ["pending", "approved", "rejected"];

// ফর্মের তথ্য ঠিক আছে কিনা দেখে। ভুল থাকলে error message ফেরত দেয়
const validateEquipment = (data) => {
  const required = [
    "name", "description", "category", "location", "rentalPrice",
    "rentalType", "availableQuantity", "condition", "brand",
    "model", "image", "terms",
  ];

  for (const field of required) {
    if (data[field] === undefined || data[field] === null || String(data[field]).trim() === "") {
      return `${field} is required`;
    }
  }
  if (!EQUIPMENT_CATEGORIES.includes(data.category)) return "invalid category";
  if (!RENTAL_TYPES.includes(data.rentalType)) return "invalid rental type";
  if (!(Number(data.rentalPrice) > 0)) return "rentalPrice must be greater than 0";
  if (!Number.isInteger(Number(data.availableQuantity)) || Number(data.availableQuantity) < 0) {
    return "availableQuantity must be a whole number (0 or more)";
  }
  return null;
};

// শুধু অনুমোদিত field নেয়। status বা owner request থেকে নেওয়া হয় না
const buildEquipmentFields = (d) => ({
  name: String(d.name).trim(),
  description: String(d.description).trim(),
  category: d.category,
  location: String(d.location).trim(),
  rentalPrice: Number(d.rentalPrice),
  rentalType: d.rentalType,
  availableQuantity: Number(d.availableQuantity),
  condition: String(d.condition).trim(),
  brand: String(d.brand).trim(),
  model: String(d.model).trim(),
  image: String(d.image).trim(),
  terms: String(d.terms).trim(),
});

// Admin সব equipment পারে, Owner শুধু নিজেরটা
const canManageEquipment = (user, item) =>
  user.role === "admin" || item.owner.email === user.email;

// Add Equipment (Owner)
app.post("/equipment", verifyToken, verifyOwner, async (req, res) => {
  try {
    const error = validateEquipment(req.body);
    if (error) {
      return res.status(400).send({ message: error });
    }

    const { equipment } = await getCollections();

    const newEquipment = {
      ...buildEquipmentFields(req.body),
      status: "pending",
      owner: {
        name: req.user.name,
        email: req.user.email,
        photo: req.user.photo,
        phone: req.user.phone,
      },
      createdAt: new Date(),
    };

    const result = await equipment.insertOne(newEquipment);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// My Equipment (Owner): নিজের equipment-এর তালিকা
app.get("/my-equipment", verifyToken, verifyOwner, async (req, res) => {
  try {
    const { equipment } = await getCollections();
    const result = await equipment
      .find({ "owner.email": req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Equipment Details (logged-in সবাই)
app.get("/equipment/:id", verifyToken, verifyAnyUser, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "invalid equipment id" });
    }

    const { equipment } = await getCollections();
    const item = await equipment.findOne({ _id: new ObjectId(id) });

    // Approved না হলে শুধু মালিক বা Admin দেখতে পারবে
    if (!item || (item.status !== "approved" && !canManageEquipment(req.user, item))) {
      return res.status(404).send({ message: "equipment not found" });
    }

    res.send(item);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Update Equipment (Owner নিজেরটা, Admin যেকোনোটা)
app.put("/equipment/:id", verifyToken, verifyOwnerOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "invalid equipment id" });
    }

    const error = validateEquipment(req.body);
    if (error) {
      return res.status(400).send({ message: error });
    }

    const { equipment } = await getCollections();
    const item = await equipment.findOne({ _id: new ObjectId(id) });

    if (!item) {
      return res.status(404).send({ message: "equipment not found" });
    }
    if (!canManageEquipment(req.user, item)) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const result = await equipment.updateOne(
      { _id: item._id },
      { $set: { ...buildEquipmentFields(req.body), updatedAt: new Date() } }
    );
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Delete Equipment (Owner নিজেরটা, Admin যেকোনোটা)
app.delete("/equipment/:id", verifyToken, verifyOwnerOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "invalid equipment id" });
    }

    const { equipment } = await getCollections();
    const item = await equipment.findOne({ _id: new ObjectId(id) });

    if (!item) {
      return res.status(404).send({ message: "equipment not found" });
    }
    if (!canManageEquipment(req.user, item)) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const result = await equipment.deleteOne({ _id: item._id });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// All Equipment (Admin): সব status-এর equipment
app.get("/admin/equipment", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { equipment } = await getCollections();
    const result = await equipment.find().sort({ createdAt: -1 }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Approve / Reject (Admin)
app.patch("/admin/equipment/:id/status", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "invalid equipment id" });
    }
    if (!EQUIPMENT_STATUSES.includes(status)) {
      return res.status(400).send({ message: "invalid status" });
    }

    const { equipment } = await getCollections();
    const result = await equipment.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "equipment not found" });
    }
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// ---------- Public Equipment Routes ----------

// Search text-এর বিশেষ চিহ্ন নিরাপদ করার helper
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// All Equipment (public): শুধু approved, server-side search/filter/sort
app.get("/equipment", async (req, res) => {
  try {
    const { search, category, rentalType, minPrice, maxPrice, availability, sort } = req.query;

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 9, 1), 50);

    // শুধু approved equipment দেখা যাবে
    const query = { status: "approved" };

    // Search: নাম, location বা category-র যেকোনোটাতে মিললেই হবে
    if (search && String(search).trim()) {
      const regex = new RegExp(escapeRegex(String(search).trim()), "i");
      query.$or = [{ name: regex }, { location: regex }, { category: regex }];
    }

    // Filters
    if (category) query.category = String(category);
    if (rentalType) query.rentalType = String(rentalType);

    // Price range
    const priceFilter = {};
    if (minPrice !== undefined && minPrice !== "" && !isNaN(Number(minPrice))) {
      priceFilter.$gte = Number(minPrice);
    }
    if (maxPrice !== undefined && maxPrice !== "" && !isNaN(Number(maxPrice))) {
      priceFilter.$lte = Number(maxPrice);
    }
    if (Object.keys(priceFilter).length > 0) query.rentalPrice = priceFilter;

    // Availability
    if (availability === "available") query.availableQuantity = { $gt: 0 };
    if (availability === "unavailable") query.availableQuantity = 0;

    // Sorting
    const sortOptions = {
      price_asc: { rentalPrice: 1 },
      price_desc: { rentalPrice: -1 },
      newest: { createdAt: -1 },
    };
    const sortBy = { ...(sortOptions[sort] || sortOptions.newest), _id: 1 };

    const { equipment } = await getCollections();
    const total = await equipment.countDocuments(query);
    const items = await equipment
      .find(query)
      .sort(sortBy)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    res.send({
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Featured Equipment (Home): ৬টি approved equipment, MongoDB limit দিয়ে
app.get("/featured-equipment", async (req, res) => {
  try {
    const { equipment } = await getCollections();
    const result = await equipment
      .find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Customer Reviews (Home)
app.get("/reviews", async (req, res) => {
  try {
    const { reviews } = await getCollections();
    const result = await reviews.find().limit(12).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// ---------- Favorites Routes (Customer) ----------

// Favorite-এ যোগ করা
app.post("/favorites", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { equipmentId } = req.body;

    if (!equipmentId || !ObjectId.isValid(equipmentId)) {
      return res.status(400).send({ message: "valid equipmentId is required" });
    }

    const { equipment, favorites } = await getCollections();

    // শুধু approved equipment favorite করা যাবে
    const item = await equipment.findOne({
      _id: new ObjectId(equipmentId),
      status: "approved",
    });
    if (!item) {
      return res.status(404).send({ message: "equipment not found" });
    }

    // আগেই যোগ করা থাকলে আবার নয়
    const existing = await favorites.findOne({
      userEmail: req.user.email,
      equipmentId: item._id,
    });
    if (existing) {
      return res.status(409).send({ message: "already in favorites" });
    }

    const result = await favorites.insertOne({
      userEmail: req.user.email,
      equipmentId: item._id,
      createdAt: new Date(),
    });
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// এই equipment favorite করা আছে কিনা (Details পেজের বাটনের জন্য)
app.get("/favorites/check/:equipmentId", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { equipmentId } = req.params;

    if (!ObjectId.isValid(equipmentId)) {
      return res.status(400).send({ message: "invalid equipment id" });
    }

    const { favorites } = await getCollections();
    const existing = await favorites.findOne({
      userEmail: req.user.email,
      equipmentId: new ObjectId(equipmentId),
    });

    res.send({ isFavorite: Boolean(existing) });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// ---------- Start ----------
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;