export default {
    providers: [
      {
        domain: `https://${process.env.VITE_CLERK_PUBLISHABLE_KEY?.match(/^pk_test_(.+?)_/)?.[1] || process.env.VITE_CLERK_PUBLISHABLE_KEY?.match(/^pk_live_(.+?)_/)?.[1]}.clerk.accounts.dev`,
        applicationID: "convex",
      },
    ]
  };
