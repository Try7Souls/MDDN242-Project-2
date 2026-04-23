new p5(function (p) {

    // ============================================================
    // STATE
    // ============================================================

    let creature;
    let state = "idle";

    let chaosTime = 0;

    let stateTimer = 0;
    let targetTimer = 0;

    let legPhase = 0;
    let peckPhase = 0;
    let pecksLeft = 0;

    let hunger = 0;

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    let seed = { x: 0, y: 0 };
    let draggingSeed = false;

    const PICK_RADIUS = 140;

    function createCreature(x, y) {
        return { x, y, targetX: x, facing: 1 };
    }

    function resetSeed() {
        seed.x = p.width - 80;
        seed.y = p.height - 80;
    }

    // ============================================================
    // SETUP
    // ============================================================

    p.setup = function () {
        let cnv = p.createCanvas(p.windowWidth - 40, p.windowHeight - 40);
        cnv.parent("canvas-container");

        creature = createCreature(p.width / 2, p.height / 2);
        resetSeed();
        enterIdle();
    };

    // ============================================================
    // BEHAVIOUR
    // ============================================================

    function enterIdle() {
        state = "idle";
        stateTimer = 0;
        targetTimer = p.int(p.random(120, 300));
    }

    function enterWalking() {
        state = "walking";
        stateTimer = 0;
        targetTimer = p.int(p.random(180, 360));
        creature.targetX = p.random(150, p.width - 150);
        creature.facing = creature.targetX > creature.x ? 1 : -1;
    }

    function enterPecking() {
        state = "pecking";
        stateTimer = 0;
        peckPhase = 0;
        pecksLeft = p.int(
            p.random(1, 2 + p.map(hunger, 0, 100, 0, 2))
        );
    }

    // ============================================================
    // DRAW LOOP
    // ============================================================

    p.draw = function () {
        p.background(255);

        chaosTime += 0.01;
        hunger = p.min(100, hunger + 0.05);

        if (!dragging && !draggingSeed) updateState();

        drawCreature(creature);
        drawSeed();
        drawHungerMeter();
    };

    function updateState() {
        stateTimer++;

        if (state === "idle" && stateTimer > targetTimer) {
            p.random() < p.map(hunger, 0, 100, 0.4, 0.75)
                ? enterPecking()
                : enterWalking();
        }

        if (state === "walking") {
            creature.x += (creature.targetX - creature.x) * 0.03;
            legPhase += 0.12;
            if (stateTimer > targetTimer) enterIdle();
        }

        if (state === "pecking") {
            peckPhase += 0.05;
            if (peckPhase > p.PI) {
                peckPhase = 0;
                pecksLeft--;
                if (pecksLeft <= 0) enterIdle();
            }
        }
    }

    // ============================================================
    // CHAOTIC SHAPE (ORIGINAL LOOK)
    // ============================================================

    function noisyEllipse(x, y, w, h, chaos) {
        p.beginShape();
        let detail = 14;
        for (let i = 0; i < p.TWO_PI; i += p.TWO_PI / detail) {
            let nx = x + p.cos(i) * (w / 2 + p.random(-chaos * 18, chaos * 18));
            let ny = y + p.sin(i) * (h / 2 + p.random(-chaos * 18, chaos * 18));
            p.vertex(nx, ny);
        }
        p.endShape(p.CLOSE);
    }

    function chaosEllipse(x, y, w, h, chaos) {
        if (chaos === 0) {
            p.ellipse(x, y, w, h);
        } else {
            noisyEllipse(x, y, w, h, chaos);
        }
    }

    // ============================================================
    // DRAW CREATURE
    // ============================================================

    function drawCreature(c) {

        let chaos = p.map(hunger, 45, 100, 0, 1);
        chaos = p.constrain(chaos, 0, 1);

        let jitterX = (p.noise(chaosTime, 0) - 0.5) * chaos * 12;
        let jitterY = (p.noise(0, chaosTime) - 0.5) * chaos * 12;

        p.push();
        p.translate(c.x + jitterX, c.y + jitterY);
        p.scale(c.facing, 1);

        // BODY
        p.noStroke();
        p.fill(220, 170, 80);
        chaosEllipse(0, 20, 220, 160, chaos);

        p.fill(235, 195, 120);
        chaosEllipse(-20, 30, 160, 120, chaos);

        // TAIL
        p.fill(210, 160, 90);
        chaosEllipse(-120, -10, 90, 80, chaos);
        chaosEllipse(-110, -40, 70, 60, chaos);
        chaosEllipse(-90, -60, 50, 40, chaos);

        // HEAD
        let peckAmt = state === "pecking"
            ? p.constrain(p.sin(peckPhase), 0, 1)
            : 0;

        p.push();
        p.translate(95 + peckAmt * 16, -40);
        p.rotate(p.radians(peckAmt * (18 + chaos * 30)));
        p.translate(0, peckAmt * (24 + chaos * 20));

        p.fill(220, 170, 80);
        chaosEllipse(0, 0, 80, 70, chaos);

        p.fill(200, 40, 40);
        p.triangle(0, -25, -15, -45, 15, -45);

        p.fill(245, 200, 60);
        p.triangle(35, 0, 70, 8, 35, 15);

        p.fill(0);
        p.ellipse(5, -5, 6, 6);
        p.pop();

        // ========================================================
        // SIMPLE BIRD LEGS (WALKING SAFE)
        // ========================================================

        p.stroke(200, 170, 60);
        p.strokeWeight(4);

        let swing = state === "walking" ? p.sin(legPhase) * 0.5 : 0;
        let legJitter = chaos * 2;

        // LEFT LEG
        p.push();
        p.translate(-20 + p.random(-legJitter, legJitter), 80);
        p.rotate(swing);

        p.line(0, 0, 0, 32);
        p.line(0, 32, -8, 38);
        p.line(0, 32, 8, 38);
        p.line(0, 32, 0, 42);
        p.pop();

        // RIGHT LEG
        p.push();
        p.translate(15 + p.random(-legJitter, legJitter), 80);
        p.rotate(-swing);

        p.line(0, 0, 0, 32);
        p.line(0, 32, -8, 38);
        p.line(0, 32, 8, 38);
        p.line(0, 32, 0, 42);
        p.pop();

        // GLITCH LINES
        if (chaos > 0.5) {
            p.stroke(0, 40);
            for (let i = 0; i < chaos * 10; i++) {
                p.line(
                    p.random(-140, 140),
                    p.random(-80, 120),
                    p.random(-140, 140),
                    p.random(-80, 120)
                );
            }
        }

        p.pop();
    }

    // ============================================================
    // SEED + UI
    // ============================================================

    function drawSeed() {
        p.push();
        p.translate(seed.x, seed.y);
        p.rotate(-0.4);
        p.noStroke();
        p.fill(40, 30, 20);
        p.ellipse(0, 0, 22, 30);
        p.pop();
    }

    function drawHungerMeter() {
        p.fill(0);
        p.text("HUNGER", 20, 30);
        p.noFill();
        p.rect(20, 40, 120, 10);
        p.fill(200, 80, 80);
        p.rect(20, 40, p.map(hunger, 0, 100, 0, 120), 10);
    }

    // ============================================================
    // INTERACTION
    // ============================================================

    p.mousePressed = function () {
        if (p.dist(p.mouseX, p.mouseY, seed.x, seed.y) < 25) {
            draggingSeed = true;
            return;
        }

        if (p.dist(p.mouseX, p.mouseY, creature.x, creature.y) < PICK_RADIUS) {
            dragging = true;
            dragOffsetX = creature.x - p.mouseX;
            dragOffsetY = creature.y - p.mouseY;
        }
    };

    p.mouseDragged = function () {
        if (draggingSeed) {
            seed.x = p.mouseX;
            seed.y = p.mouseY;
        }

        if (dragging) {
            creature.x = p.mouseX + dragOffsetX;
            creature.y = p.mouseY + dragOffsetY;
        }
    };

    p.mouseReleased = function () {
        if (draggingSeed && p.dist(seed.x, seed.y, creature.x, creature.y) < 120) {
            hunger = p.max(0, hunger - 25);
            resetSeed();
        }

        draggingSeed = false;
        dragging = false;
        enterIdle();
    };

    p.windowResized = function () {
        p.resizeCanvas(p.windowWidth - 40, p.windowHeight - 40);
        resetSeed();
    };

}, document.body);
