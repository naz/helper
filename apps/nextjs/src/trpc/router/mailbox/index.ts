import { currentUser } from "@clerk/nextjs/server";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { subHours } from "date-fns";
import { and, count, eq, isNotNull, isNull, SQL } from "drizzle-orm";
import { z } from "zod";
import { setupOrganizationForNewUser } from "@/auth/lib/authService";
import { assertDefined } from "@/components/utils/assert";
import { db } from "@/db/client";
import { conversations, mailboxes } from "@/db/schema";
import { inngest } from "@/inngest/client";
import { getLatestEvents } from "@/lib/data/dashboardEvent";
import { getMailboxInfo } from "@/lib/data/mailbox";
import { getClerkOrganization } from "@/lib/data/organization";
import { getMemberStats } from "@/lib/data/stats";
import { protectedProcedure } from "@/trpc/trpc";
import { conversationsRouter } from "./conversations/index";
import { customersRouter } from "./customers";
import { faqsRouter } from "./faqs";
import { githubRouter } from "./github";
import { metadataEndpointRouter } from "./metadataEndpoint";
import { preferencesRouter } from "./preferences";
import { mailboxProcedure } from "./procedure";
import { slackRouter } from "./slack";
import { toolsRouter } from "./tools";
import { websitesRouter } from "./websites";

export { mailboxProcedure };

export const mailboxRouter = {
  list: protectedProcedure.query(async ({ ctx }) => {
    const organization = await getClerkOrganization(ctx.session.orgId);
    const allMailboxes = await db.query.mailboxes.findMany({
      where: eq(mailboxes.clerkOrganizationId, organization.id),
      columns: {
        id: true,
        name: true,
        slug: true,
      },
    });

    if (allMailboxes.length === 0) {
      const mailbox = await setupOrganizationForNewUser(
        await getClerkOrganization(ctx.session.orgId),
        assertDefined(await currentUser()),
      );
      allMailboxes.push(mailbox);
    }
    return allMailboxes;
  }),
  openCount: mailboxProcedure.query(async ({ ctx }) => {
    const countOpenStatus = async (where?: SQL) => {
      const result = await db
        .select({ count: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.mailboxId, ctx.mailbox.id),
            eq(conversations.status, "open"),
            isNull(conversations.mergedIntoId),
            where,
          ),
        );
      return result[0]?.count ?? 0;
    };

    const [all, mine, assigned] = await Promise.all([
      countOpenStatus(),
      countOpenStatus(eq(conversations.assignedToClerkId, ctx.session.userId)),
      countOpenStatus(isNotNull(conversations.assignedToClerkId)),
    ]);

    return {
      conversations: all,
      mine,
      assigned,
      unassigned: all - assigned,
    };
  }),
  get: mailboxProcedure.query(async ({ ctx }) => {
    return await getMailboxInfo(ctx.mailbox);
  }),
  update: mailboxProcedure
    .input(
      z.object({
        slackAlertChannel: z.string().optional(),
        githubRepoOwner: z.string().optional(),
        githubRepoName: z.string().optional(),
        widgetDisplayMode: z.enum(["off", "always", "revenue_based"]).optional(),
        widgetDisplayMinValue: z.number().optional(),
        autoRespondEmailToChat: z.boolean().optional(),
        widgetHost: z.string().optional(),
        vipThreshold: z.number().optional(),
        vipChannelId: z.string().optional(),
        vipExpectedResponseHours: z.number().optional(),
        autoCloseEnabled: z.boolean().optional(),
        autoCloseDaysOfInactivity: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db.update(mailboxes).set(input).where(eq(mailboxes.id, ctx.mailbox.id));
    }),
  members: mailboxProcedure
    .input(
      z.object({
        period: z.enum(["24h", "7d", "30d", "1y"]),
        customDate: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const periodInHours = {
        "24h": 24,
        "7d": 24 * 7,
        "30d": 24 * 30,
        "1y": 24 * 365,
      } as const;

      const startDate = input.customDate || subHours(now, periodInHours[input.period]);
      return await getMemberStats(ctx.mailbox, { startDate, endDate: now });
    }),
  latestEvents: mailboxProcedure
    .input(z.object({ cursor: z.date().optional() }))
    .query(({ ctx, input }) => getLatestEvents(ctx.mailbox, input.cursor)),
  conversations: conversationsRouter,
  faqs: faqsRouter,

  slack: slackRouter,
  github: githubRouter,
  tools: toolsRouter,
  customers: customersRouter,
  websites: websitesRouter,
  metadataEndpoint: metadataEndpointRouter,
  autoClose: mailboxProcedure.input(z.object({ mailboxId: z.number() })).mutation(async ({ input }) => {
    const { mailboxId } = input;

    const mailbox = await db.query.mailboxes.findFirst({
      where: eq(mailboxes.id, mailboxId),
      columns: {
        id: true,
        autoCloseEnabled: true,
      },
    });

    if (!mailbox) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Mailbox not found" });
    }

    if (!mailbox.autoCloseEnabled) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Auto-close is not enabled for this mailbox",
      });
    }

    await inngest.send({
      name: "conversations/auto-close.check",
      data: {
        mailboxId: Number(mailboxId),
      },
    });

    return {
      success: true,
      message: "Auto-close job triggered successfully",
    };
  }),
  preferences: preferencesRouter,
} satisfies TRPCRouterRecord;
