---
title: Platform operations
status: draft
year: 2027
---

# Effortless platform operations

## Problem

Running the platform across more teams does not get cheaper per team — it gets more expensive,
on two fronts at once. The centre of excellence has no group-driven way to govern many teams,
and a delivery team, once its process is in production, has no leaner way to run it day to day
than it did when it owned exactly one.

Neither cost falls as the estate grows, because five parts of the daily operating surface remain
genuinely unaddressed: identity and permissions, catalogue governance, the ability to interact
through an API rather than a console, fleet-wide health visibility, and audit.

> None of these is built to be centrally automated, self-service, or consumable by an agent.

Some real progress already exists — basic multi-provider synchronisation, a job dashboard,
incident resolution through listeners — but the console today is still not suitable at scale.

## What we will do

We will make the operating surface addressable. Every action a person can take in the console
should be available through an API, and every API should be enumerable, so that a team can
automate the parts of operations that are specific to them without waiting on us.

That is the whole of it. There is no second phase where this becomes ambitious; the ambition is
in doing the unglamorous half completely rather than the interesting half twice.
