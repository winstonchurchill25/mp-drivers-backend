// server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load environment variables FIRST
dotenv.config();

// Initialize Stripe AFTER loading env vars
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const app = express();

const PORT = process.env.PORT || 5000;

// Email transporter setup
const emailTransporter = nodemailer.createTransport({
  service: "gmail", // or "hotmail", etc.
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// In-memory storage for MVP (replace with database later)
let bookings = [];
let contacts = [];

// Middleware
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' })); // For Stripe webhooks
app.use(express.json());

// Routes
app.get("/", (req, res) => {
  res.json({ message: "MP Drivers Backend is running with payments!" });
});

app.post("/api/test", (req, res) => {
  res.json({ message: "Server is working!" });
});

// ============= BOOKING ROUTES =============

// Create payment intent for booking
app.post('/api/book/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', bookingDetails } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      metadata: {
        booking_id: Date.now().toString(),
        customer_email: bookingDetails.email,
        service_type: bookingDetails.serviceType
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      bookingId: paymentIntent.metadata.booking_id
    });
  } catch (error) {
    console.error('Payment intent creation failed:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// Confirm booking after successful payment
app.post('/api/book/confirm-booking', async (req, res) => {
  try {
    const { paymentIntentId, bookingDetails } = req.body;

    // Verify payment with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }

    // Create booking record
    const booking = {
      id: paymentIntent.metadata.booking_id,
      ...bookingDetails,
      paymentIntentId,
      status: 'confirmed',
      createdAt: new Date().toISOString(),
      amount: paymentIntent.amount / 100
    };

    bookings.push(booking);

    // Send confirmation email
    await sendBookingConfirmation(booking);

    res.json({ 
      success: true, 
      bookingId: booking.id,
      message: 'Booking confirmed and email sent!'
    });

  } catch (error) {
    console.error('Booking confirmation failed:', error);
    res.status(500).json({ error: 'Booking confirmation failed' });
  }
});

// Get booking by ID
app.get('/api/book/:id', (req, res) => {
  const booking = bookings.find(b => b.id === req.params.id);
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json(booking);
});

// Get all bookings (admin endpoint)
app.get('/api/book', (req, res) => {
  res.json(bookings);
});

// ============= CONTACT ROUTES =============

// Submit contact form
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    // Validate required fields
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    // Create contact record
    const contact = {
      id: Date.now().toString(),
      name,
      email,
      subject: subject || 'Contact Form Submission',
      message,
      createdAt: new Date().toISOString()
    };

    contacts.push(contact);

    // Send notification email
    await sendContactNotification(contact);

    res.json({ 
      success: true, 
      message: 'Contact form submitted successfully!'
    });

  } catch (error) {
    console.error('Contact submission failed:', error);
    res.status(500).json({ error: 'Contact submission failed' });
  }
});

// Get all contacts (admin endpoint)
app.get('/api/contact', (req, res) => {
  res.json(contacts);
});

// ============= WEBHOOK HANDLER =============

// Stripe webhook handler
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('Payment succeeded:', event.data.object.id);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

// ============= EMAIL FUNCTIONS =============

// Send booking confirmation email
async function sendBookingConfirmation(booking) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: booking.email,
    subject: 'Booking Confirmation - MP Drivers',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Booking Confirmation</h2>
        <p>Dear ${booking.name},</p>
        <p>Thank you for your booking with MP Drivers! Here are your booking details:</p>
        
        <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Booking Details</h3>
          <p><strong>Booking ID:</strong> ${booking.id}</p>
          <p><strong>Service:</strong> ${booking.serviceType}</p>
          <p><strong>Date:</strong> ${booking.date}</p>
          <p><strong>Time:</strong> ${booking.time}</p>
          <p><strong>Amount Paid:</strong> $${booking.amount}</p>
        </div>
        
        <p>We'll send you a reminder closer to your appointment date.</p>
        <p>If you need to make any changes, please contact us.</p>
        
        <p>Best regards,<br>MP Drivers Team</p>
      </div>
    `
  };

  try {
    await emailTransporter.sendMail(mailOptions);
    console.log('Confirmation email sent to:', booking.email);
  } catch (error) {
    console.error('Email sending failed:', error);
    throw error;
  }
}

// Send contact form notification
async function sendContactNotification(contact) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER, // Send to yourself
    subject: `New Contact Form: ${contact.subject}`,
    html: `
      <h3>New Contact Form Submission</h3>
      <p><strong>Name:</strong> ${contact.name}</p>
      <p><strong>Email:</strong> ${contact.email}</p>
      <p><strong>Subject:</strong> ${contact.subject}</p>
      <p><strong>Message:</strong></p>
      <p>${contact.message}</p>
      <p><strong>Submitted:</strong> ${contact.createdAt}</p>
    `
  };

  try {
    await emailTransporter.sendMail(mailOptions);
    console.log('Contact notification sent');
  } catch (error) {
    console.error('Contact notification failed:', error);
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
