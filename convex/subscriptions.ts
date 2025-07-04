import { Polar } from "@polar-sh/sdk";

interface Price {
  id: string;
  amount: number;
  currency: string;
  interval: string;
}

interface CleanedItem {
  id: string;
  name: string;
  description: string;
  isRecurring: boolean;
  prices: Price[];
}

interface GetAvailablePlansResult {
  items: CleanedItem[];
  pagination: {
    totalItems: number;
    page: number;
    pageSize: number;
  };
}
import { v } from "convex/values";
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { api } from "./_generated/api";
import { action, httpAction, mutation, query } from "./_generated/server";

const createCheckout = async ({
  customerEmail,
  productPriceId,
  successUrl,
  metadata,
}: {
  customerEmail: string;
  productPriceId: string;
  successUrl: string;
  metadata?: Record<string, string>;
}) => {
  try {
    console.log("createCheckout started with:", { customerEmail, productPriceId, successUrl });

    if (!process.env.POLAR_ACCESS_TOKEN) {
      throw new Error("POLAR_ACCESS_TOKEN is not configured");
    }

    if (!process.env.POLAR_ORGANIZATION_ID) {
      throw new Error("POLAR_ORGANIZATION_ID is not configured");
    }

    const polar = new Polar({
      server: (process.env.POLAR_SERVER as "sandbox" | "production") || "sandbox",
      accessToken: process.env.POLAR_ACCESS_TOKEN,
    });

    console.log("Polar client initialized, fetching products...");

    // Get product ID from price ID
    const productsResponse = await polar.products.list({
      organizationId: process.env.POLAR_ORGANIZATION_ID,
      isArchived: false,
    });

    console.log("Products response received");

    let productId = null;

    // The response structure is { result: { items: [...], pagination: {...} } }
    for await (const response of productsResponse) {
      const responseData = response as any;

      // Access the actual products from result.items
      if (responseData.result && responseData.result.items) {
        for (const productData of responseData.result.items) {
          const hasPrice = productData.prices?.some(
            (price: any) => price.id === productPriceId
          );
          if (hasPrice) {
            productId = productData.id;
            console.log("Found product ID:", productId, "for price ID:", productPriceId);
            break;
          }
        }
      }

      if (productId) break; // Exit outer loop if found
    }

    if (!productId) {
      throw new Error(`Product not found for price ID: ${productPriceId}`);
    }

    const checkoutData = {
      products: [productId],
      successUrl: successUrl,
      customerEmail: customerEmail,
      metadata: {
        ...metadata,
        priceId: productPriceId,
      },
    };

    console.log(
      "Creating checkout with data:",
      JSON.stringify(checkoutData, null, 2)
    );

    const result = await polar.checkouts.create(checkoutData);

    console.log("Checkout created successfully:", result);
    return result;
  } catch (error) {
    console.error("createCheckout error:", error);
    throw error;
  }
};

// Action to fetch available plans from Polar (can use fetch)




export const getAvailablePlansAction = action({
  handler: async (): Promise<GetAvailablePlansResult> => {
    if (!process.env.POLAR_ACCESS_TOKEN) {
      throw new Error("POLAR_ACCESS_TOKEN is not configured");
    }

    const polar = new Polar({
      server: (process.env.POLAR_SERVER as "sandbox" | "production") || "sandbox",
      accessToken: process.env.POLAR_ACCESS_TOKEN,
    });

        // Get products from Polar
    const productsResponse = await polar.products.list({
      organizationId: process.env.POLAR_ORGANIZATION_ID,
      isArchived: false,
    });

    const items: CleanedItem[] = [];

        // The response structure is { result: { items: [...], pagination: {...} } }
    for await (const response of productsResponse) {
      const responseData = response as any;

      // Access the actual products from result.items
      if (responseData.result && responseData.result.items) {
        for (const productData of responseData.result.items) {
          items.push({
            id: productData.id,
            name: productData.name,
            description: productData.description || "",
            isRecurring: productData.isRecurring,
            prices: productData.prices?.map((price: any) => ({
              id: price.id,
              amount: price.priceAmount,
              currency: price.priceCurrency,
              interval: price.recurringInterval || "one_time",
            })) || [],
          });
        }
      }
    }

    return {
      items,
      pagination: {
        totalItems: items.length,
        page: 1,
        pageSize: items.length,
      },
    };
  },
});

export const createCheckoutAction = action({
  args: {
    priceId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      console.log("createCheckoutAction called with priceId:", args.priceId);

      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        throw new Error("Not authenticated");
      }

      console.log("User identity:", identity.subject);

      // First check if user exists
      let user = await ctx.runQuery(api.users.findUserByToken, {
        tokenIdentifier: identity.subject,
      });

      console.log("Found user:", user);

      // If user doesn't exist, create them
      if (!user) {
        console.log("Creating new user...");
        user = await ctx.runMutation(api.users.upsertUser);

        if (!user) {
          throw new Error("Failed to create user");
        }
        console.log("Created user:", user);
      }

      if (!user.email) {
        throw new Error("User email is required for checkout");
      }

      console.log("Creating checkout for user email:", user.email);

      // Check environment variables
      if (!process.env.FRONTEND_URL) {
        throw new Error("FRONTEND_URL environment variable is not set");
      }

      const checkout = await createCheckout({
        customerEmail: user.email,
        productPriceId: args.priceId,
        successUrl: `${process.env.FRONTEND_URL}/success`,
        metadata: {
          userId: user.tokenIdentifier,
        },
      });

      console.log("Checkout result:", checkout);

      if (!checkout || !checkout.url) {
        throw new Error("Failed to create checkout - no URL returned");
      }

      return checkout.url;
    } catch (error) {
      console.error("createCheckoutAction error:", error);
      throw error;
    }
  },
});

export const checkUserSubscriptionStatus = query({
  args: {
    userId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let tokenIdentifier: string;

    if (args.userId) {
      // Use provided userId directly as tokenIdentifier (they are the same)
      tokenIdentifier = args.userId;
    } else {
      // Fall back to auth context
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        return { hasActiveSubscription: false };
      }
      tokenIdentifier = identity.subject;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .unique();

    if (!user) {
      return { hasActiveSubscription: false };
    }

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", user.tokenIdentifier))
      .first();

    const hasActiveSubscription = subscription?.status === "active";
    return { hasActiveSubscription };
  },
});

export const checkUserSubscriptionStatusByClerkId = query({
  args: {
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    // Find user by Clerk user ID (this assumes the tokenIdentifier contains the Clerk user ID)
    // In Clerk, the subject is typically in the format "user_xxxxx" where xxxxx is the Clerk user ID
    const tokenIdentifier = `user_${args.clerkUserId}`;

    let user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .unique();

    // If not found with user_ prefix, try the raw userId
    if (!user) {
      user = await ctx.db
        .query("users")
        .withIndex("by_token", (q) => q.eq("tokenIdentifier", args.clerkUserId))
        .unique();
    }

    if (!user) {
      return { hasActiveSubscription: false };
    }

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", user.tokenIdentifier))
      .first();

    const hasActiveSubscription = subscription?.status === "active";
    return { hasActiveSubscription };
  },
});

export const fetchUserSubscription = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.subject))
      .unique();

    if (!user) {
      return null;
    }

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("userId", (q) => q.eq("userId", user.tokenIdentifier))
      .first();

    return subscription;
  },
});

export const handleWebhookEvent = mutation({
  args: {
    body: v.any(),
  },
  handler: async (ctx, args) => {
    // Extract event type from webhook payload
    const eventType = args.body.type;

    // Store webhook event
    await ctx.db.insert("webhookEvents", {
      type: eventType,
      polarEventId: args.body.data.id,
      createdAt: args.body.data.created_at,
      modifiedAt: args.body.data.modified_at || args.body.data.created_at,
      data: args.body.data,
    });

    switch (eventType) {
      case "subscription.created":
        // Insert new subscription
        await ctx.db.insert("subscriptions", {
          polarId: args.body.data.id,
          polarPriceId: args.body.data.price_id,
          currency: args.body.data.currency,
          interval: args.body.data.recurring_interval,
          userId: args.body.data.metadata.userId,
          status: args.body.data.status,
          currentPeriodStart: new Date(
            args.body.data.current_period_start
          ).getTime(),
          currentPeriodEnd: new Date(
            args.body.data.current_period_end
          ).getTime(),
          cancelAtPeriodEnd: args.body.data.cancel_at_period_end,
          amount: args.body.data.amount,
          startedAt: new Date(args.body.data.started_at).getTime(),
          endedAt: args.body.data.ended_at
            ? new Date(args.body.data.ended_at).getTime()
            : undefined,
          canceledAt: args.body.data.canceled_at
            ? new Date(args.body.data.canceled_at).getTime()
            : undefined,
          customerCancellationReason:
            args.body.data.customer_cancellation_reason || undefined,
          customerCancellationComment:
            args.body.data.customer_cancellation_comment || undefined,
          metadata: args.body.data.metadata || {},
          customFieldData: args.body.data.custom_field_data || {},
          customerId: args.body.data.customer_id,
        });
        break;

      case "subscription.updated":
        // Find existing subscription
        const existingSub = await ctx.db
          .query("subscriptions")
          .withIndex("polarId", (q) => q.eq("polarId", args.body.data.id))
          .first();

        if (existingSub) {
          await ctx.db.patch(existingSub._id, {
            amount: args.body.data.amount,
            status: args.body.data.status,
            currentPeriodStart: new Date(
              args.body.data.current_period_start
            ).getTime(),
            currentPeriodEnd: new Date(
              args.body.data.current_period_end
            ).getTime(),
            cancelAtPeriodEnd: args.body.data.cancel_at_period_end,
            metadata: args.body.data.metadata || {},
            customFieldData: args.body.data.custom_field_data || {},
          });
        }
        break;

      case "subscription.active":
        // Find and update subscription
        const activeSub = await ctx.db
          .query("subscriptions")
          .withIndex("polarId", (q) => q.eq("polarId", args.body.data.id))
          .first();

        if (activeSub) {
          await ctx.db.patch(activeSub._id, {
            status: args.body.data.status,
            startedAt: new Date(args.body.data.started_at).getTime(),
          });
        }
        break;

      case "subscription.canceled":
        // Find and update subscription
        const canceledSub = await ctx.db
          .query("subscriptions")
          .withIndex("polarId", (q) => q.eq("polarId", args.body.data.id))
          .first();

        if (canceledSub) {
          await ctx.db.patch(canceledSub._id, {
            status: args.body.data.status,
            canceledAt: args.body.data.canceled_at
              ? new Date(args.body.data.canceled_at).getTime()
              : undefined,
            customerCancellationReason:
              args.body.data.customer_cancellation_reason || undefined,
            customerCancellationComment:
              args.body.data.customer_cancellation_comment || undefined,
          });
        }
        break;

      case "subscription.uncanceled":
        // Find and update subscription
        const uncanceledSub = await ctx.db
          .query("subscriptions")
          .withIndex("polarId", (q) => q.eq("polarId", args.body.data.id))
          .first();

        if (uncanceledSub) {
          await ctx.db.patch(uncanceledSub._id, {
            status: args.body.data.status,
            cancelAtPeriodEnd: false,
            canceledAt: undefined,
            customerCancellationReason: undefined,
            customerCancellationComment: undefined,
          });
        }
        break;

      case "subscription.revoked":
        // Find and update subscription
        const revokedSub = await ctx.db
          .query("subscriptions")
          .withIndex("polarId", (q) => q.eq("polarId", args.body.data.id))
          .first();

        if (revokedSub) {
          await ctx.db.patch(revokedSub._id, {
            status: "revoked",
            endedAt: args.body.data.ended_at
              ? new Date(args.body.data.ended_at).getTime()
              : undefined,
          });
        }
        break;

      case "order.created":
        // Orders are handled through the subscription events
        break;

      default:
        console.log(`Unhandled event type: ${eventType}`);
        break;
    }
  },
});

// Use our own validation similar to validateEvent from @polar-sh/sdk/webhooks
// The only diffference is we use btoa to encode the secret since Convex js runtime doesn't support Buffer
const validateEvent = (
  body: string | Buffer,
  headers: Record<string, string>,
  secret: string
) => {
  const base64Secret = btoa(secret);
  const webhook = new Webhook(base64Secret);
  webhook.verify(body, headers);
};

export const paymentWebhook = httpAction(async (ctx, request) => {
  try {
    const rawBody = await request.text();

    // Internally validateEvent uses headers as a dictionary e.g. headers["webhook-id"]
    // So we need to convert the headers to a dictionary
    // (request.headers is a Headers object which is accessed as request.headers.get("webhook-id"))
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Validate the webhook event
    if (!process.env.POLAR_WEBHOOK_SECRET) {
      throw new Error(
        "POLAR_WEBHOOK_SECRET environment variable is not configured"
      );
    }
    validateEvent(rawBody, headers, process.env.POLAR_WEBHOOK_SECRET);

    const body = JSON.parse(rawBody);

    // track events and based on events store data
    await ctx.runMutation(api.subscriptions.handleWebhookEvent, {
      body,
    });

    return new Response(JSON.stringify({ message: "Webhook received!" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return new Response(
        JSON.stringify({ message: "Webhook verification failed" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    return new Response(JSON.stringify({ message: "Webhook failed" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
});

export const createCustomerPortalUrl = action({
  handler: async (ctx, args: { customerId: string }) => {
    const polar = new Polar({
      server: "sandbox",
      accessToken: process.env.POLAR_ACCESS_TOKEN,
    });

    try {
      const result = await polar.customerSessions.create({
        customerId: args.customerId,
      });

      // Only return the URL to avoid Convex type issues
      return { url: result.customerPortalUrl };
    } catch (error) {
      console.error("Error creating customer session:", error);
      throw new Error("Failed to create customer session");
    }
  },
});
