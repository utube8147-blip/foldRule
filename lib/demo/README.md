# Experiments (delete when done)

Three features under test, kept out of the workspace on purpose:

1. **Template** – start a new project from a past one (groups, materials, rates, markups).
2. **Symbol count** – drag a box round one symbol, find the rest on the page.
3. **Rooms** – read room names and stated areas from the drawing's text.

To remove everything:

    rm -rf lib/demo hooks/demo components/demo "app/(project)/demo" tests/demo.test.ts

and delete the one line marked `EXPERIMENTS LINK` in `app/(project)/takeoff-full/page.tsx`.
Nothing else in the app imports from these folders.
