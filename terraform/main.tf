terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# VPC — use the existing default VPC
# ---------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

# ECS security group — used by ECS tasks
resource "aws_security_group" "ecs" {
  name        = "yarddomino-ecs"
  description = "Security group for YardDomino ECS tasks"
  vpc_id      = data.aws_vpc.default.id

  # Allow Redis (Valkey) access within this security group
  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    self        = true
    description = "Redis access within ECS security group"
  }

  # Allow server port from load balancer
  ingress {
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    description     = "App server access from load balancer"
  }

  # Allow all outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "yarddomino-ecs"
    Project = "yarddomino"
  }
}

# ALB security group — used by the ECS load balancer
resource "aws_security_group" "alb" {
  name        = "yarddomino-alb"
  description = "Security group for YardDomino load balancer"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS from internet"
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP from internet"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "yarddomino-alb"
    Project = "yarddomino"
  }
}

# RDS security group — restricts PostgreSQL to ECS tasks only
resource "aws_security_group" "rds" {
  name        = "yarddomino-rds"
  description = "Security group for YardDomino RDS — ECS access only"
  vpc_id      = data.aws_vpc.default.id

  # PostgreSQL only accessible from ECS security group
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
    description     = "PostgreSQL access from ECS tasks only"
  }

  # Allow all traffic within itself (internal VPC communication)
  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "yarddomino-rds"
    Project = "yarddomino"
  }
}

# ---------------------------------------------------------------------------
# RDS — PostgreSQL database
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "yarddomino-db-subnet-group"
  subnet_ids = data.aws_subnets.default.ids

  tags = {
    Name    = "yarddomino-db-subnet-group"
    Project = "yarddomino"
  }
}

resource "aws_db_instance" "postgres" {
  identifier        = "yarddomino-testdb"
  engine            = "postgres"
  engine_version    = "15"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  storage_type      = "gp2"

  db_name  = "yarddomino_test"
  username = var.db_username
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # Not publicly accessible — only reachable from within the VPC
  publicly_accessible = false

  skip_final_snapshot = true

  tags = {
    Name    = "yarddomino-testdb"
    Project = "yarddomino"
  }
}

# ---------------------------------------------------------------------------
# ElastiCache — Valkey (Redis-compatible) cluster
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "yarddomino-redis-subnet-group"
  subnet_ids = data.aws_subnets.default.ids

  tags = {
    Name    = "yarddomino-redis-subnet-group"
    Project = "yarddomino"
  }
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "yarddominotest-redis"
  engine               = "valkey"
  engine_version       = "9.1"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.valkey9"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.ecs.id]

  # Encryption in transit — requires rediss:// URL
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  tags = {
    Name    = "yarddominotest-redis"
    Project = "yarddomino"
  }
}

# ---------------------------------------------------------------------------
# ECR — Container registry
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "app" {
  name                 = "yarddomino-test"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name    = "yarddomino-test"
    Project = "yarddomino"
  }
}

# ---------------------------------------------------------------------------
# ECS — Cluster and service
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = "default"

  tags = {
    Project = "yarddomino"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "yarddomino"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512

  container_definitions = jsonencode([
    {
      name      = "yarddomino"
      image     = "${aws_ecr_repository.app.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 3001
          hostPort      = 3001
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3001" },
        {
          name  = "DATABASE_URL"
          value = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}?sslmode=no-verify"
        },
        {
          name  = "REDIS_URL"
          value = "rediss://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379"
        },
        { name = "JWT_SECRET", value = var.jwt_secret },
        { name = "ADMIN_TOKEN", value = var.admin_token },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/yarddomino"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Project = "yarddomino"
  }
}

resource "aws_ecs_service" "app" {
  name            = "yarddomino-test"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  tags = {
    Project = "yarddomino"
  }
}
