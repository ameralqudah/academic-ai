# Reference outputs for the P1-C statistics engine (scripts/stats-engine.ts).
#
# Not run in CI and not needed at runtime: the dataset and JSON it writes are
# committed, and the engine is compared against them. Re-run only to regenerate
# (R >= 4.3; base R, plus lavaan/semTools for HTMT):
#
#   Rscript scripts/references/engine.R
#
# Every definition here is the one the engine documents: G1/G2 moments, the
# corrected item-total correlation, Koenker's studentised Breusch-Pagan,
# Games-Howell via ptukey/qtukey, iterated principal-axis factoring from SMCs
# (max |change| < 1e-6), stats::varimax / stats::promax, factors signed to a
# positive loading sum and ordered by sum of squared loadings.

suppressPackageStartupMessages({ library(jsonlite); library(lavaan); library(semTools) })

out_data <- "evals/fixtures/datasets"
out_ref  <- "evals/fixtures/references"

# ---------------------------------------------------------------- data --------
set.seed(20260924)
n <- 240
f1 <- rnorm(n); f2 <- 0.35 * f1 + sqrt(1 - 0.35^2) * rnorm(n)
x <- round(rnorm(n, 50, 10), 2)
m <- round(0.45 * (x - 50) / 10 + rnorm(n), 3)
w <- round(rnorm(n, 3, 1), 3)
bin <- rbinom(n, 1, 0.4)
y <- round(2 + 0.25 * (x - 50) / 10 + 0.5 * m + 0.3 * w + 0.35 * ((x - 50) / 10) * (w - 3) + 0.4 * bin + rnorm(n), 3)
group <- sample(c("A", "B", "C"), n, replace = TRUE, prob = c(.4, .35, .25))
score <- round(10 + c(A = 0, B = 1.2, C = 2.0)[group] + rnorm(n) * c(A = 1, B = 2, C = 3.5)[group], 3)
item <- function(f, l) pmin(5, pmax(1, round(3 + 1.1 * (l * f + sqrt(1 - l^2) * rnorm(n)))))
T1 <- item(f1, .8); T2 <- item(f1, .75); T3 <- item(f1, .7); T4 <- item(f1, .65)
S1 <- item(f2, .8); S2 <- item(f2, .7); S3 <- item(f2, .75); S4 <- item(f2, .6)
d <- data.frame(x, m, w, y, bin, group, score, T1, T2, T3, T4, S1, S2, S3, S4)
# Missing cells, so every analysis has to exclude and count them.
d$x[c(5, 17, 90)] <- NA
d$m[c(33, 150)] <- NA
d$score[c(12, 200)] <- NA
d$T2[c(7, 111)] <- NA
write.csv(d, file.path(out_data, "engine_survey.csv"), row.names = FALSE, na = "")

# ---------------------------------------------------------- helpers -----------
G1 <- function(v) { v <- v[!is.na(v)]; n <- length(v); s <- sd(v); n / ((n - 1) * (n - 2)) * sum(((v - mean(v)) / s)^3) }
G2 <- function(v) { v <- v[!is.na(v)]; n <- length(v); s <- sd(v)
  n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * sum(((v - mean(v)) / s)^4) - 3 * (n - 1)^2 / ((n - 2) * (n - 3)) }
alpha <- function(X) { k <- ncol(X); k / (k - 1) * (1 - sum(apply(X, 2, var)) / var(rowSums(X))) }
coefs <- function(fit, level = 0.95) {
  s <- summary(fit)$coefficients; ci <- confint(fit, level = level)
  lapply(rownames(s), function(r) list(term = r, b = s[r, 1], se = s[r, 2], t = s[r, 3], p = s[r, 4], lower = ci[r, 1], upper = ci[r, 2]))
}
ref <- list(versions = list(R = R.version.string, lavaan = as.character(packageVersion("lavaan")), semTools = as.character(packageVersion("semTools"))))

# ------------------------------------------------------- descriptives ---------
ref$descriptives <- lapply(c("x", "y", "score"), function(v) { z <- d[[v]]; zz <- z[!is.na(z)]
  list(variable = v, n = length(zz), missing = sum(is.na(z)), mean = mean(zz), median = median(zz), sd = sd(zz), variance = var(zz),
       min = min(zz), max = max(zz), skewness = G1(zz), kurtosis = G2(zz)) })

# --------------------------------------------------------- reliability --------
Ti <- na.omit(d[, c("T1", "T2", "T3", "T4")])
R <- cor(Ti); k <- 4; rbar <- mean(R[upper.tri(R)])
ref$reliability <- list(n = nrow(Ti), alpha = alpha(Ti), standardised = k * rbar / (1 + (k - 1) * rbar),
  items = lapply(colnames(Ti), function(it) list(item = it, itemTotal = cor(Ti[[it]], rowSums(Ti[, setdiff(colnames(Ti), it)])),
                                                  alphaIfDeleted = alpha(Ti[, setdiff(colnames(Ti), it)]))))

# --------------------------------------------------------- correlation --------
pairs <- list(c("x", "m"), c("x", "y"), c("m", "y"))
ref$correlation <- lapply(pairs, function(p) { t <- cor.test(d[[p[1]]], d[[p[2]]])
  list(a = p[1], b = p[2], r = unname(t$estimate), p = t$p.value, lower = t$conf.int[1], upper = t$conf.int[2], n = sum(complete.cases(d[, p]))) })
ref$spearman <- lapply(pairs, function(p) { t <- suppressWarnings(cor.test(d[[p[1]]], d[[p[2]]], method = "spearman", exact = FALSE))
  list(a = p[1], b = p[2], rho = unname(t$estimate)) })

# ---------------------------------------------------------- regression --------
rd <- na.omit(d[, c("y", "x", "m", "bin")])
fit <- lm(y ~ x + m + bin, data = rd)
s <- summary(fit)
e <- residuals(fit)
aux <- lm(I(e^2) ~ x + m + bin, data = rd)
ref$regression <- list(n = nrow(rd), coefficients = coefs(fit), r2 = s$r.squared, adjR2 = s$adj.r.squared,
  F = unname(s$fstatistic[1]), df1 = unname(s$fstatistic[2]), df2 = unname(s$fstatistic[3]),
  Fp = unname(pf(s$fstatistic[1], s$fstatistic[2], s$fstatistic[3], lower.tail = FALSE)),
  sigma = s$sigma, maxCooks = max(cooks.distance(fit)), maxLeverage = max(hatvalues(fit)),
  bp = nrow(rd) * summary(aux)$r.squared, bpDf = 3, bpP = pchisq(nrow(rd) * summary(aux)$r.squared, 3, lower.tail = FALSE),
  dw = sum(diff(e)^2) / sum(e^2))

# --------------------------------------------------------------- ANOVA --------
ad <- na.omit(d[, c("score", "group")]); ad$group <- factor(ad$group)
av <- anova(aov(score ~ group, data = ad))
welch <- oneway.test(score ~ group, data = ad, var.equal = FALSE)
ss_b <- av["group", "Sum Sq"]; ss_w <- av["Residuals", "Sum Sq"]; ms_w <- av["Residuals", "Mean Sq"]; df_b <- av["group", "Df"]
tk <- TukeyHSD(aov(score ~ group, data = ad), conf.level = 0.95)$group
gh <- list(); lv <- levels(ad$group); kk <- length(lv)
for (i in 1:(kk - 1)) for (j in (i + 1):kk) {
  a <- ad$score[ad$group == lv[i]]; b <- ad$score[ad$group == lv[j]]
  va <- var(a) / length(a); vb <- var(b) / length(b); se <- sqrt(va + vb)
  df <- (va + vb)^2 / (va^2 / (length(a) - 1) + vb^2 / (length(b) - 1))
  diff <- mean(a) - mean(b); t <- diff / se; crit <- qtukey(0.95, kk, df) / sqrt(2)
  gh[[length(gh) + 1]] <- list(a = lv[i], b = lv[j], diff = diff, se = se, df = df, t = t,
                               p = ptukey(abs(t) * sqrt(2), kk, df, lower.tail = FALSE), lower = diff - crit * se, upper = diff + crit * se)
}
ref$anova <- list(n = nrow(ad), F = av["group", "F value"], df1 = df_b, df2 = av["Residuals", "Df"], p = av["group", "Pr(>F)"],
  welchF = unname(welch$statistic), welchDf1 = unname(welch$parameter[1]), welchDf2 = unname(welch$parameter[2]), welchP = welch$p.value,
  eta2 = ss_b / (ss_b + ss_w), omega2 = max(0, (ss_b - df_b * ms_w) / (ss_b + ss_w + ms_w)),
  tukey = lapply(rownames(tk), function(r) list(pair = r, diff = tk[r, "diff"], lower = tk[r, "lwr"], upper = tk[r, "upr"], p = tk[r, "p adj"])),
  gamesHowell = gh)

# ----------------------------------------------------------------- EFA --------
Ei <- na.omit(d[, c("T1", "T2", "T3", "T4", "S1", "S2", "S3", "S4")])
Rm <- cor(Ei); p <- ncol(Rm); Ri <- solve(Rm)
P <- -Ri / sqrt(outer(diag(Ri), diag(Ri))); diag(P) <- 0; R0 <- Rm; diag(R0) <- 0
kmo <- sum(R0^2) / (sum(R0^2) + sum(P^2)); msa <- rowSums(R0^2) / (rowSums(R0^2) + rowSums(P^2))
bart <- -(nrow(Ei) - 1 - (2 * p + 5) / 6) * log(det(Rm))
top <- function(M, k) { e <- eigen(M, symmetric = TRUE); e$vectors[, 1:k, drop = FALSE] %*% diag(sqrt(pmax(e$values[1:k], 0)), k) }
paf <- function(R, k) { h <- 1 - 1 / diag(solve(R)); for (it in 1:1000) { Rh <- R; diag(Rh) <- h; L <- top(Rh, k); hn <- rowSums(L^2)
  ch <- max(abs(hn - h)); h <- hn; if (ch < 1e-6) break }; L }
post <- function(L, phi = NULL) { s <- ifelse(colSums(L) < 0, -1, 1); L <- sweep(L, 2, s, "*")
  if (!is.null(phi)) phi <- phi * outer(s, s); o <- order(-colSums(L^2)); L <- L[, o, drop = FALSE]
  if (!is.null(phi)) phi <- phi[o, o]; list(L = unname(L), phi = if (is.null(phi)) NULL else unname(phi)) }
L0 <- paf(Rm, 2)
vm <- post(unclass(varimax(L0)$loadings))
pm <- promax(L0, m = 4); pmPhi <- solve(t(pm$rotmat) %*% pm$rotmat); pmx <- post(unclass(pm$loadings), pmPhi)
pca <- post(unclass(varimax(top(Rm, 2))$loadings))
ref$efa <- list(n = nrow(Ei), items = colnames(Ei), kmo = kmo, msa = unname(msa), bartlett = bart, bartlettDf = p * (p - 1) / 2,
  bartlettP = pchisq(bart, p * (p - 1) / 2, lower.tail = FALSE), eigenvalues = eigen(Rm, symmetric = TRUE)$values,
  communalities = rowSums(L0^2), pafVarimax = vm$L, pafPromax = pmx$L, promaxPhi = pmx$phi, pcaVarimax = pca$L)

# ----------------------------------------------------------- mediation --------
md <- na.omit(d[, c("x", "m", "y")])
fa <- lm(m ~ x, md); fb <- lm(y ~ x + m, md); fc <- lm(y ~ x, md)
ref$mediation <- list(n = nrow(md), a = coefs(fa)[[2]], b = coefs(fb)[[3]], direct = coefs(fb)[[2]], total = coefs(fc)[[2]],
  indirect = coef(fa)[["x"]] * coef(fb)[["m"]], sdX = sd(md$x), sdY = sd(md$y))

# ---------------------------------------------------------- moderation --------
od <- na.omit(d[, c("x", "w", "y")])
xc <- od$x - mean(od$x); wc <- od$w - mean(od$w)
fm <- lm(od$y ~ xc + wc + I(xc * wc)); fr <- lm(od$y ~ xc + wc); V <- vcov(fm); sdw <- sd(od$w)
cond <- lapply(c(-sdw, 0, sdw), function(wv) { th <- coef(fm)[2] + coef(fm)[4] * wv
  se <- sqrt(V[2, 2] + wv^2 * V[4, 4] + 2 * wv * V[2, 4]); t <- th / se; crit <- qt(0.975, df.residual(fm))
  list(w = wv, effect = unname(th), se = se, t = unname(t), p = 2 * pt(-abs(t), df.residual(fm)), lower = unname(th - crit * se), upper = unname(th + crit * se)) })
dr2 <- summary(fm)$r.squared - summary(fr)$r.squared
ref$moderation <- list(n = nrow(od), coefficients = coefs(fm), r2 = summary(fm)$r.squared, deltaR2 = dr2,
  Fchange = dr2 / ((1 - summary(fm)$r.squared) / df.residual(fm)), conditional = cond)

# ---------------------------------------------------------- HTMT (HS) ---------
hs <- HolzingerSwineford1939[, paste0("x", 1:9)]
ht <- htmt("visual =~ x1 + x2 + x3\n textual =~ x4 + x5 + x6\n speed =~ x7 + x8 + x9", data = hs, htmt2 = FALSE)  # classic HTMT (Henseler 2015)
ref$htmt <- list(visualTextual = ht["textual", "visual"], visualSpeed = ht["speed", "visual"], textualSpeed = ht["speed", "textual"])

write_json(ref, file.path(out_ref, "engine.json"), digits = NA, auto_unbox = TRUE, pretty = TRUE)
cat("wrote", file.path(out_ref, "engine.json"), "\n")
