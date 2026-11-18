// seed-demo.js
// Demo booking ও payment বসানোর script। আবার চালালে আগের demo data মুছে নতুন করে বসায়।
require("dotenv").config();
const { MongoClient } = require("mongodb");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const calculate = (item, start, end, quantity) => {
  const days = Math.round((end - start) / MS_PER_DAY) + 1;
  let periods = days;
  if (item.rentalType === "Weekly") periods = Math.ceil(days / 7);
  if (item.rentalType === "Monthly") periods = Math.ceil(days / 30);
  return { days, totalAmount: Math.round(periods * item.rentalPrice * quantity * 100) / 100 };
};

const demoBookings = [
  { equipment: "Kubota Power Tiller", customer: { name: "Rafiq Ahmed", email: "rafiq.demo@example.com" }, quantity: 2, start: "2026-06-12", end: "2026-06-14", booked: "2026-06-08" },
  { equipment: "Canon EOS R6 Camera", customer: { name: "Nusrat Jahan", email: "nusrat.demo@example.com" }, quantity: 1, start: "2026-07-05", end: "2026-07-07", booked: "2026-07-01" },
  { equipment: "Pioneer DJ Sound System", customer: { name: "Imran Hossain", email: "imran.demo@example.com" }, quantity: 1, start: "2026-07-20", end: "2026-07-21", booked: "2026-07-15" },
  { equipment: "Kubota Power Tiller", customer: { name: "Customer One", email: "customer@example.com" }, quantity: 1, start: "2026-08-10", end: "2026-08-16", booked: "2026-08-06" },
  { equipment: "Canon EOS R6 Camera", customer: { name: "Farhana Akter", email: "farhana.demo@example.com" }, quantity: 1, start: "2026-08-22", end: "2026-08-24", booked: "2026-08-18" },
  { equipment: "Pioneer DJ Sound System", customer: { name: "Rafiq Ahmed", email: "rafiq.demo@example.com" }, quantity: 2, start: "2026-09-12", end: "2026-09-13", booked: "2026-09-08" },
  { equipment: "JCB 3DX Excavator", customer: { name: "Nusrat Jahan", email: "nusrat.demo@example.com" }, quantity: 1, start: "2026-09-25", end: "2026-09-26", booked: "2026-09-20" },
  { equipment: "Canon EOS R6 Camera", customer: { name: "Customer One", email: "customer@example.com" }, quantity: 1, start: "2026-10-15", end: "2026-10-17", booked: "2026-10-10" },
  { equipment: "Kubota Power Tiller", customer: { name: "Imran Hossain", email: "imran.demo@example.com" }, quantity: 3, start: "2026-10-25", end: "2026-10-27", booked: "2026-10-20" },
  { equipment: "Pioneer DJ Sound System", customer: { name: "Farhana Akter", email: "farhana.demo@example.com" }, quantity: 1, start: "2026-10-28", end: "2026-10-30", booked: "2026-10-22" },
  { equipment: "Kubota Power Tiller", customer: { name: "Nusrat Jahan", email: "nusrat.demo@example.com" }, quantity: 2, start: "2026-11-10", end: "2026-11-12", booked: "2026-11-06" },
  { equipment: "Canon EOS R6 Camera", customer: { name: "Rafiq Ahmed", email: "rafiq.demo@example.com" }, quantity: 1, start: "2026-11-22", end: "2026-11-24", booked: "2026-11-12" },
];

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME);
    const equipment = db.collection("equipment");
    const users = db.collection("users");
    const bookings = db.collection("bookings");
    const payments = db.collection("payments");

    // আগের demo data মুছে ফেলা (বারবার চালালে ডুপ্লিকেট হবে না)
    await payments.deleteMany({ isDemo: true });
    await bookings.deleteMany({ isDemo: true });

    let created = 0;

    for (const [index, demo] of demoBookings.entries()) {
      const item = await equipment.findOne({ name: demo.equipment });
      if (!item) {
        console.log(`Skipped: "${demo.equipment}" not found in database`);
        continue;
      }

      const start = new Date(`${demo.start}T00:00:00.000Z`);
      const end = new Date(`${demo.end}T00:00:00.000Z`);
      const bookingDate = new Date(`${demo.booked}T09:00:00.000Z`);
      const paidAt = new Date(`${demo.booked}T09:05:00.000Z`);
      const { days, totalAmount } = calculate(item, start, end, demo.quantity);
      const transactionId = `demo_pi_${String(index + 1).padStart(3, "0")}`;

      // আসল user থাকলে তার তথ্য নেওয়া
      const realUser = await users.findOne({ email: demo.customer.email });
      const customer = {
        name: realUser ? realUser.name : demo.customer.name,
        email: demo.customer.email,
        photo: realUser ? realUser.photo : "",
      };

      const inserted = await bookings.insertOne({
        equipmentId: item._id,
        equipmentName: item.name,
        equipmentImage: item.image,
        customer,
        owner: item.owner,
        startDate: start,
        endDate: end,
        days,
        quantity: demo.quantity,
        rentalType: item.rentalType,
        unitPrice: item.rentalPrice,
        totalAmount,
        contactNumber: "01700000000",
        deliveryAddress: "Demo address, Dhaka",
        notes: "",
        paymentStatus: "paid",
        bookingStatus: "confirmed", // শেষ তারিখ পেরোলে server নিজে "completed" করবে
        bookingDate,
        paidAt,
        transactionId,
        isDemo: true,
      });

      await payments.insertOne({
        bookingId: inserted.insertedId,
        equipmentId: item._id,
        equipmentName: item.name,
        customerEmail: customer.email,
        ownerEmail: item.owner.email,
        amount: totalAmount,
        currency: "usd",
        transactionId,
        sessionId: `demo_cs_${String(index + 1).padStart(3, "0")}`,
        paymentStatus: "paid",
        paidAt,
        isDemo: true,
      });

      created++;
    }

    console.log(`Done. ${created} demo bookings and payments added.`);
  } finally {
    await client.close();
  }
}

run().catch((error) => console.error("Seed failed:", error.message));