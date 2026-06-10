import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as MicrosoftStrategy } from "passport-microsoft";
import bcrypt from "bcrypt";
import { storage } from "./storage";
import type { User } from "@shared/schema";
import crypto from "crypto";
import { sendVerificationEmail } from "./email";

export function setupAuth() {
  // Local Strategy for email/password authentication
  passport.use(new LocalStrategy({
    usernameField: 'email',
    passwordField: 'password'
  },
  async (email: string, password: string, done) => {
    try {
      const user = await storage.getUserByEmail(email);
      
      if (!user) {
        return done(null, false, { message: "Invalid email or password." });
      }

      // Check if this is an OAuth user
      if (user.authProvider !== 'local') {
        return done(null, false, { 
          message: `This account uses ${user.authProvider} login. Please use the ${user.authProvider} button to sign in.` 
        });
      }

      // Check if email is verified (only for local auth)
      if (!user.isEmailVerified) {
        return done(null, false, { message: "Please verify your email before logging in." });
      }
      
      // Verify password
      if (!user.password) {
        return done(null, false, { message: "Invalid account configuration." });
      }
      
      const isValidPassword = await bcrypt.compare(password, user.password);
      
      if (!isValidPassword) {
        return done(null, false, { message: "Invalid email or password." });
      }
      
      // Update last login
      const updatedUser = await storage.updateUserLastLogin(user.id);
      
      return done(null, updatedUser);
    } catch (error) {
      console.error("Error in local authentication strategy:", error);
      return done(error, false);
    }
  }));

   // ========== GOOGLE STRATEGY ==========
   passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackURL: process.env.GOOGLE_CALLBACK_URL!,
    scope: ['profile', 'email']
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Check if user exists with this Google ID
      let user = await storage.getUserByGoogleId(profile.id);

      if (!user) {
        // Check if email already exists (user might have signed up with email)
        const email = profile.emails?.[0]?.value;
        if (email) {
          const existingUser = await storage.getUserByEmail(email);
          
          if (existingUser) {
            // Link Google account to existing user
            user = await storage.updateUser(existingUser.id, {
              googleId: profile.id,
              authProvider: 'google',
              isEmailVerified: true, // Google emails are verified
              profilePicture: profile.photos?.[0]?.value || existingUser.profilePicture,
            });
          }
        }
      }

      if (!user) {
        // Create new user
        const email = profile.emails?.[0]?.value;
        const displayName = profile.displayName || email?.split('@')[0] || 'User';
        
        user = await storage.createUser({
          email: email!,
          displayName,
          firstName: profile.name?.givenName,
          lastName: profile.name?.familyName,
          authProvider: 'google',
          googleId: profile.id,
          isEmailVerified: true, // Google emails are verified
          profilePicture: profile.photos?.[0]?.value,
          password: null, // No password for OAuth users
        });
      }

      // Update last login
      await storage.updateUserLastLogin(user.id);
      
      return done(null, user);
    } catch (error) {
      console.error("Error in Google authentication strategy:", error);
      return done(error as Error, undefined);
    }
  }));

  // ========== MICROSOFT STRATEGY ==========
  passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID!,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
    callbackURL: process.env.MICROSOFT_CALLBACK_URL!,
    scope: ['user.read']
  },
  async (_accessToken:any, _refreshToken:any, profile:any, done:any) => {
    try {
      // Check if user exists with this Microsoft ID
      let user = await storage.getUserByMicrosoftId(profile.id);

      if (!user) {
        // Check if email already exists
        const email = profile.emails?.[0]?.value;
        if (email) {
          const existingUser = await storage.getUserByEmail(email);
          
          if (existingUser) {
            // Link Microsoft account to existing user
            user = await storage.updateUser(existingUser.id, {
              microsoftId: profile.id,
              authProvider: 'microsoft',
              isEmailVerified: true, // Microsoft emails are verified
              profilePicture: profile.photos?.[0]?.value || existingUser.profilePicture,
            });
          }
        }
      }

      if (!user) {
        // Create new user
        const email = profile.emails?.[0]?.value;
        const displayName = profile.displayName || email?.split('@')[0] || 'User';
        
        user = await storage.createUser({
          email: email!,
          displayName,
          firstName: profile.name?.givenName,
          lastName: profile.name?.familyName,
          authProvider: 'microsoft',
          microsoftId: profile.id,
          isEmailVerified: true, // Microsoft emails are verified
          profilePicture: profile.photos?.[0]?.value,
          password: null, // No password for OAuth users
        });
      }

      // Update last login
      await storage.updateUserLastLogin(user.id);
      
      return done(null, user);
    } catch (error) {
      console.error("Error in Microsoft authentication strategy:", error);
      return done(error as Error, undefined);
    }
  }));

  // Serialize user for session
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });


  // Deserialize user from session
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
}


// Middleware to check if user is authenticated
export function requireAuth(req: any, res: any, next: any) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: "Authentication required" });
}


// Helper functions for password operations
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
}


export async function validatePassword(password: string): Promise<{ isValid: boolean; message?: string }> {
  if (password.length < 8) {
    return { isValid: false, message: "Password must be at least 8 characters long." };
  }
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
    return { isValid: false, message: "Password must contain at least one uppercase letter, one lowercase letter, and one number." };
  }
  return { isValid: true };
}


export function validateEmail(email: string): { isValid: boolean; message?: string } {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { isValid: false, message: "Please enter a valid email address." };
  }
  return { isValid: true };
}


export function generateVerificationToken(): { token: string; expiry: Date } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  return { token, expiry };
}